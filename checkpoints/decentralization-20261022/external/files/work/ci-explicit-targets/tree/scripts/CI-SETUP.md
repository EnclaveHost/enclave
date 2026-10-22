# Configure CI deployment targets

`ci-setup.sh` provisions SSH access and repository settings for the API and DNS
roles selected by the operator. It does not deploy services, publish the site,
or change smart contracts. Site publication has its own owner-authorized workflow.

Supply the installed service directories and hostnames that the GitHub runner
can reach. Local-only SSH aliases are unsuitable unless the runner separately
has their configuration. For the existing control VM, the API and DNS directories
are `/opt/nan-relay` and `/opt/enclave-dns`; the directory name does not select a
server.

```bash
export RELAY_DEPLOY_ROLES=api,dns
export RELAY_API_TARGET=deploy@api.example
export RELAY_API_DIR=/opt/nan-relay
export RELAY_DNS_TARGET=deploy@dns.example
export RELAY_DNS_DIR=/opt/enclave-dns
export KEYFILE=/path/to/dedicated-ci-key
export DEPLOY_KNOWN_HOSTS_FILE=/path/to/verified-known-hosts

bash scripts/ci-setup.sh --check-config
bash scripts/ci-setup.sh
```

Verify host keys through an established trusted channel before creating the
known-hosts file. Setup requires a matching entry for every selected hostname;
it does not discover or trust keys with `ssh-keyscan`. The operator's existing
SSH identity must already have permission to install the dedicated public key
on each selected host. `gh` must be authenticated as a repository administrator.

Validation checks configuration and public host-key entries only. Provisioning
checks every selected host before generating or installing a key. It then
installs the public key, stores `DEPLOY_SSH_KEY`, and sets the selected
`RELAY_*` variables and `DEPLOY_KNOWN_HOSTS`. It retains the authenticated
administrator as the required reviewer for the `contract-deploy` environment.
Set `DEPLOYER_PRIVATE_KEY` there separately only if using CI contract deployment.

Existing unrelated variables are left untouched. The workflow uses only the
explicitly selected roles; old `SITE_SSH_HOST` and `RELAY_SSH_HOST` values do not
select relay targets. A setup failure can leave public keys installed on earlier
hosts or partially updated GitHub settings; correct the failure and rerun with
the same key and configuration. No application deployment is triggered by setup.
