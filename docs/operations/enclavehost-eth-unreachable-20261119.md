# enclavehost.eth answered 504 through eth.limo (found 2026-11-19)

`enclavehost.eth` carries an IPNS content hash (`k51qzi5uqu5dma8l0w05o02gkz7l80f3r3mb536qh8fuhrr2qj4nsa2afe9b52`).
The `ipns-publisher` deployment (0xd9798e4c on nucbox-k11-4) signs that name's record with the value it reads from
`https://ipfs.enclave.host/site-root`, and advertises `ipfs.enclave.host` to the IPNI index (cid.contact) as the
HTTP provider of the site. A public IPFS node resolves the name, finds the provider, and fetches the tree block by
block as `GET /ipfs/<cid>?format=raw`.

## What was wrong

The name resolved (the record is current, value `bafybeihvox7sjpnt5uuaqa6we4zuigwl5ohdx4jjvnxyiccx76a2nx7pbe`, the
site release of 2026-10-24). The content did not load, for two reasons, each enough by itself. Both were reproduced
with a fresh kubo 0.42 node: the root block arrived in a second, `index.html` never did.

1. **The edges did not serve the tree's blocks.** `ipfs.enclave.host` on the four edges answers a site root as its
   root block, its whole CAR and its files by path, and single blocks from `/opt/enclave-site-blocks/ipfs/<cid>`.
   That directory was last filled on 2026-10-21; the release of 2026-10-24 never added its blocks, so 20 of the
   root's 31 children answered 404 as raw blocks.
2. **Only the root was advertised.** The deployment runs with `ipni.announceAllBlocks: false`, set in August because
   the all-blocks path then fetched the whole CAR through the storage adapter and failed on a short read. A node that
   already holds the root block (several public nodes do, from earlier attempts) asks the network for the children
   by their own CIDs, finds no provider record for them, and gives up. The provider is only found by a node that
   has to look up the root itself.

## What was changed

- **The blocks are served.** `scripts/site-release/blocks.mjs` writes every block of a verified release CAR under
  its CID (a block already there with other bytes is an error). Run on each edge for the current root: 708 blocks,
  246 new. Every child of the root now answers 200 as a raw block, by query and by Accept header.
- **`ipns-publisher` 1.0.6 advertises every block** (enclave-apps main 4574705): with `announceAllBlocks` it walks
  the tree one dag-pb block per step as raw bytes, checks each against its CID, and takes raw leaves from their
  parent's links without fetching them; the saved state records whether the head covers every block, so a root
  advertised alone is advertised again, and a failed walk is retried on the next signed value. Run locally with a
  throwaway key against the live gateway (no indexer, no record published): 708 blocks, the CAR's count.
  The component (`bafybeideqwmd32owzmsy2xutg6ck33rrnjvgjmepvdvzwjhomkkv67hkeu`) is in the storage adapter, where
  the relay reads it before it releases the deployment's secrets.

## It loads again (2026-11-19 05:45 UTC)

The owner signed the three transactions (blocks 59381017, 59381053, 59381088) and the node relaunched the deployment
once, on 1.0.6 with `announceAllBlocks: true`, at 05:37. The new partition signed nothing: its first publish at
start failed before its network was ready, and the publisher tries again only after `republishSecs` (four hours).
It was asked to publish through its own `/publish` route with the deploy key, as the site deploy script does. It
then walked the tree (about a minute), advertised 708 blocks and announced to cid.contact, which listed
`ipfs.enclave.host` for the `index.html` block within seconds. `https://enclavehost.eth.limo/` answered 200 in two
seconds, with four other pages and a script.

## What is not done

- **A restarted publisher publishes nothing for four hours.** The record it had published stays valid for a week
  and the index keeps the last advertisement, so the name keeps loading; a new site root or a changed flag waits
  for the next round unless `/publish` is called. The first publish should be retried soon after a failure.
- **Nothing fills the block store on a site release.** The step is a tool, not part of the rollout the edges run.
  With every block advertised, a root whose blocks are missing fails the publisher's walk (its status page says
  which block), and that root is then not advertised at all.
- **The name shows the site of 2026-10-24, not what enclave.host serves.** `/site-root` on the edges still names
  that release; the tree enclave.host serves today is a composite directory with no CAR, so it has no root the
  name could point to.
- The publisher's own DHT publish fails (`no peers responded to the walk`, no connection made). Resolution works
  through the delegated router, which is also what kubo asks first.
