// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IVFToken {
    function balanceOf(address) external view returns(uint256);
    function approve(address,uint256) external returns(bool);
    function transfer(address,uint256) external returns(bool);
}
interface IVFLedger {
    struct Deployment { bytes32 id; address owner; string appRef; string ports; string configCid;
        uint16 gpuMilli; uint16 cpuMilli; uint32 appPort; bool isPublic; bool active; uint64 createdAt;
        uint256 rate; uint256 balance6; uint256 spent6; bytes32 runner; address runnerOperator; uint64 leaseUntil; }
    function get(bytes32) external view returns(Deployment memory);
    function usdc() external view returns(address);
    function payout() external view returns(address);
    function prover() external view returns(address);
    function registry() external view returns(address);
    function proofRequired() external view returns(bool);
    function earned6(address) external view returns(uint256);
    function rateFor(bytes32,bytes32) external view returns(uint256);
    function create(string calldata,uint16,uint16,uint32,string calldata,bool,string calldata,address,uint256,uint256) external returns(bytes32);
    function fund(bytes32,uint256) external;
    function setActive(bytes32,bool) external;
    function refundableOf(bytes32) external view returns(uint256);
    function refund(bytes32) external;
}
interface IVFProof {
    function deployments() external view returns(address);
    function checkpoint(bytes32,bytes32,uint64,uint64,bytes32,bytes calldata) external;
}
interface IVFController {
    function executorFor(bytes32,address) external view returns(address);
}

/// A separate, immutable wallet for one source deployment and payer. No admin,
/// arbitrary call, transferable owner or token withdrawal to an executor exists.
/// Unused platform fees return to the ledger's platform payout, never an agent.
contract VerificationFeeWallet {
    address public immutable controller;
    IVFLedger public immutable ledger;
    IVFToken public immutable token;
    bytes32 public immutable source;
    address public immutable payer;
    modifier onlyController(){require(msg.sender==controller,"controller only");_;}
    constructor(address l,bytes32 s,address p) {
        controller=msg.sender;ledger=IVFLedger(l);token=IVFToken(ledger.usdc());source=s;payer=p;
    }
    function create(string calldata appRef,string calldata config,uint16 cpu,uint256 rate) external onlyController returns(bytes32){
        return ledger.create(appRef,0,cpu,8000,"",true,config,address(0),0,rate);
    }
    function fund(bytes32 id,uint256 amount) external onlyController {
        require(ledger.get(id).owner==address(this),"not wallet job");
        require(token.approve(address(ledger),amount),"approve failed");ledger.fund(id,amount);
    }
    function stop(bytes32 id) external onlyController returns(bool) {
        IVFLedger.Deployment memory d=ledger.get(id);require(d.owner==address(this),"not wallet job");
        if(d.active)ledger.setActive(id,false);
        if(d.runner!=bytes32(0)&&d.leaseUntil>block.timestamp)return false;
        if(ledger.refundableOf(id)>0)ledger.refund(id);
        return true;
    }
    function returnUnused() external onlyController {
        uint256 amount=token.balanceOf(address(this));if(amount>0)require(token.transfer(ledger.payout(),amount),"return failed");
    }
    /// ERC-1271 solely for readable EIP-191 secret-management messages. It cannot
    /// authorize USDC EIP-712 transfers/permits. Signature = abi.encode(message,rawSig).
    function isValidSignature(bytes32 hash,bytes calldata signature) external view returns(bytes4) {
        (string memory message,bytes memory sig)=abi.decode(signature,(string,bytes));
        bytes memory text=bytes(message);bytes memory prefix=bytes("enclave-secrets:put:");
        if(text.length<prefix.length||sig.length!=65)return 0xffffffff;
        for(uint256 i;i<prefix.length;i++)if(text[i]!=prefix[i])return 0xffffffff;
        if(keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n",_decimal(text.length),text))!=hash)return 0xffffffff;
        bytes32 r;bytes32 s;uint8 v;
        assembly { r:=mload(add(sig,32)) s:=mload(add(sig,64)) v:=byte(0,mload(add(sig,96))) }
        if(uint256(s)>0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0||v<27||v>28)return 0xffffffff;
        address signer=ecrecover(hash,v,r,s);
        address executor=IVFController(controller).executorFor(source,payer);
        return signer!=address(0)&&signer==executor ? bytes4(0x1626ba7e):bytes4(0xffffffff);
    }
    function _decimal(uint256 n) private pure returns(string memory) {
        uint256 digits;uint256 x=n;do{digits++;x/=10;}while(x>0);
        bytes memory result=new bytes(digits);while(digits>0){result[--digits]=bytes1(uint8(48+n%10));n/=10;}
        return string(result);
    }
}

/// Fees are routed atomically to a distinct payer/source wallet. No pooled fund,
/// owner key, rescue function or discretionary treasury spending exists here.
contract EnclaveVerificationFees {
    uint16 public constant FEE_BPS=500; // 5% of platform fee = 1% gross at an 80/20 split
    IVFLedger public immutable ledger;
    IVFProof public immutable proof;
    IVFToken public immutable token;
    struct Policy {
        address payer; address executor; address wallet; uint64 expires; uint64 epoch;
        uint16 revenueBps; uint16 maxCpuMilli; uint256 dailyCap6; uint256 jobCap6;
        uint256 maxRate6; uint256 available6; string appRef; string backend;
    }
    struct Day {uint256 day;uint256 spent6;}
    struct Job {bytes32 source;address wallet;bytes32 hostId;uint64 epoch;uint64 expires;uint256 rate6;uint256 amount6;bool funded;uint64 stopAfter;}
    mapping(bytes32=>Policy) public policies;
    mapping(bytes32=>mapping(address=>address)) public wallets;
    mapping(address=>bool) public isWallet;
    mapping(bytes32=>Job) public jobs;
    mapping(address=>Day) public dailySpend;
    bool private entered;
    event Configured(bytes32 indexed source,address indexed payer,address wallet,uint64 epoch);
    event FeeAllocated(bytes32 indexed source,address indexed payer,address wallet,uint256 amount6);
    event BudgetEarned(bytes32 indexed source,uint256 serviceCredit6,uint256 budget6);
    event JobCreated(bytes32 indexed source,bytes32 indexed job,bytes32 indexed hostId,uint256 amount6);
    event JobFunded(bytes32 indexed source,bytes32 indexed job,uint256 amount6);
    modifier lock(){require(!entered,"reentrant");entered=true;_;entered=false;}
    constructor(address l,address p){
        ledger=IVFLedger(l);proof=IVFProof(p);token=IVFToken(ledger.usdc());
        require(ledger.prover()==p&&proof.deployments()==l,"wrong proof pair");
    }
    function configure(bytes32 source,address executor,uint16 revenueBps,uint16 maxCpuMilli,
        uint256 dailyCap6,uint256 jobCap6,uint256 maxRate6,uint64 expires,string calldata appRef,string calldata backend) external lock {
        require(ledger.get(source).owner==msg.sender,"not source owner");
        require(!isWallet[msg.sender]&&jobs[source].wallet==address(0),"recursive source");
        require(executor!=address(0)&&revenueBps>0&&revenueBps<=1000&&maxCpuMilli>0&&maxCpuMilli<=1000,"policy bounds");
        require(jobCap6>0&&jobCap6<=dailyCap6&&maxRate6>0&&expires>block.timestamp,"policy bounds");
        require(bytes(appRef).length>10&&bytes(appRef).length<=256,"app reference");
        bytes32 b=keccak256(bytes(backend));require(b==keccak256("snp-guest-per-app")||b==keccak256("hyperv-partition-per-app"),"isolation backend");
        address wallet=wallets[source][msg.sender];
        if(wallet==address(0)){
            wallet=address(new VerificationFeeWallet(address(ledger),source,msg.sender));
            wallets[source][msg.sender]=wallet;isWallet[wallet]=true;
        }
        uint64 epoch=policies[source].epoch+1;
        policies[source]=Policy(msg.sender,executor,wallet,expires,epoch,revenueBps,maxCpuMilli,dailyCap6,jobCap6,maxRate6,0,appRef,backend);
        emit Configured(source,msg.sender,wallet,epoch);
    }
    function revoke(bytes32 source) external lock {
        Policy storage p=policies[source];require(p.payer==msg.sender,"not payer");
        p.expires=0;p.available6=0;p.epoch++;
        VerificationFeeWallet(p.wallet).returnUnused();
    }
    function executorFor(bytes32 source,address payer) external view returns(address){
        Policy storage p=policies[source];
        return p.payer==payer&&p.expires>block.timestamp&&ledger.get(source).owner==payer?p.executor:address(0);
    }
    /// Called after exactly amount6 USDC lands from the ledger, within funding.
    function routeFee(bytes32 source,address payer,uint256 amount6) external {
        require(msg.sender==address(ledger),"ledger only");
        Policy storage p=policies[source];uint256 allocated;
        if(p.payer==payer&&p.expires>block.timestamp&&ledger.get(source).owner==payer
            &&!isWallet[payer]&&jobs[source].wallet==address(0)){
            allocated=amount6*FEE_BPS/10000;
            if(allocated>0){require(token.transfer(p.wallet,allocated),"fee transfer failed");emit FeeAllocated(source,payer,p.wallet,allocated);}
        }
        if(amount6>allocated)require(token.transfer(ledger.payout(),amount6-allocated),"payout failed");
    }
    /// Real proof credit, not booked time or advertised capacity, earns permission
    /// to spend previously allocated fees. Real wallet balance is a second cap.
    function checkpoint(bytes32 source,bytes32 enclaveId,uint64 upto,uint64 anchorBlock,bytes32 anchorHash,bytes calldata sig) external lock {
        IVFLedger.Deployment memory d=ledger.get(source);uint256 beforeCredit=ledger.earned6(d.runnerOperator);
        proof.checkpoint(source,enclaveId,upto,anchorBlock,anchorHash,sig);
        uint256 credit=ledger.earned6(d.runnerOperator)-beforeCredit;Policy storage p=policies[source];
        if(p.expires<=block.timestamp||p.payer!=d.owner||!ledger.proofRequired()||jobs[source].wallet!=address(0))return;
        uint256 budget=credit*p.revenueBps/10000;p.available6+=budget;emit BudgetEarned(source,credit,budget);
    }
    function _policy(bytes32 source) private view returns(Policy storage p){
        p=policies[source];require(p.expires>block.timestamp&&msg.sender==p.executor,"inactive executor");
        require(ledger.get(source).owner==p.payer,"source owner changed");
    }
    function createJob(bytes32 source,bytes32 hostId,uint16 cpu,uint256 rate6,uint64 duration,uint64 expires,bytes32 tag) external lock returns(bytes32 id){
        Policy storage p=_policy(source);
        require(cpu>0&&cpu<=p.maxCpuMilli&&rate6>0&&rate6<=p.maxRate6&&duration>=10&&duration<=3600,"job bounds");
        require(expires>block.timestamp&&expires+duration<=p.expires&&expires<=block.timestamp+1 hours,"job expiry");
        uint256 amount=rate6*duration;require(amount<=p.jobCap6&&amount<=p.available6&&amount<=token.balanceOf(p.wallet),"job budget");
        // Caller controls only a fixed-size public request tag. No arbitrary
        // app, networking, isolation downgrade, publisher fee or token destination.
        string memory config=string.concat('{"config":{"requestTag":"',_hex(tag),'"},"isolation":{"require":"',p.backend,'"}}');
        id=VerificationFeeWallet(p.wallet).create(p.appRef,config,cpu,rate6);
        jobs[id]=Job(source,p.wallet,hostId,p.epoch,expires,rate6,amount,false,expires+duration);
        emit JobCreated(source,id,hostId,amount);
    }
    function fundJob(bytes32 source,bytes32 id) external lock {
        Policy storage p=_policy(source);Job storage j=jobs[id];
        require(j.source==source&&j.wallet==p.wallet&&j.epoch==p.epoch&&!j.funded&&j.expires>block.timestamp,"invalid job");
        IVFLedger.Deployment memory d=ledger.get(id);
        require(d.owner==p.wallet&&d.active&&d.balance6==0&&d.spent6==0&&d.runner==bytes32(0),"not fresh job");
        require(ledger.rateFor(id,j.hostId)==j.rate6,"host offer changed");
        require(j.amount6<=p.jobCap6&&j.amount6<=p.available6,"job budget");
        Day storage day=dailySpend[p.payer];uint256 today=block.timestamp/1 days;
        if(day.day!=today){day.day=today;day.spent6=0;}
        require(day.spent6+j.amount6<=p.dailyCap6,"daily cap");
        p.available6-=j.amount6;day.spent6+=j.amount6;j.funded=true;
        VerificationFeeWallet(p.wallet).fund(id,j.amount6);emit JobFunded(source,id,j.amount6);
    }
    /// Anyone may finish cleanup after expiration/revocation. Before then only
    /// payer or executor may stop a test. Refunds stay in its fee wallet.
    function stopJob(bytes32 id) external lock returns(bool){
        Job storage j=jobs[id];require(j.wallet!=address(0),"unknown job");Policy storage p=policies[j.source];
        bool expired=j.stopAfter<=block.timestamp||p.expires<=block.timestamp||p.epoch!=j.epoch||ledger.get(j.source).owner!=p.payer;
        require(expired||msg.sender==p.executor||msg.sender==p.payer,"not authorized");
        bool done=VerificationFeeWallet(j.wallet).stop(id);
        if(done&&(p.expires<=block.timestamp||p.wallet!=j.wallet||ledger.get(j.source).owner!=p.payer))
            VerificationFeeWallet(j.wallet).returnUnused();return done;
    }
    function fundedJob(bytes32 id) external view returns(bool){return jobs[id].funded;}
    function _hex(bytes32 tag) private pure returns(string memory){
        bytes memory result=new bytes(64);bytes16 alphabet="0123456789abcdef";
        for(uint256 i;i<32;i++){result[2*i]=alphabet[uint8(tag[i])>>4];result[2*i+1]=alphabet[uint8(tag[i])&15];}return string(result);
    }
}
