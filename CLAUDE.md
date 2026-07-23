# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo does

A two-stage provisioning pipeline for a kubeadm-managed Kubernetes cluster on VMware vSphere:

1. **Pulumi (`index.ts`)** clones VMs from an existing vCenter template and boots them via cloud-init.
2. **Ansible (`ansible/playbook.yml`)** configures the resulting hosts with containerd, kubelet/kubeadm/kubectl, and node users — this stage is OS-level only and has no VMware/Pulumi awareness.

These stages are independent: Pulumi's job ends at "VMs exist and are reachable over SSH"; Ansible's job starts from "an inventory of reachable hosts."

## Commands

```bash
npm install          # install Pulumi/TypeScript deps
npm run build         # tsc compile (also npm run lint / npm run typecheck — all aliases for tsc)
pulumi up             # provision/update VMs
pulumi destroy        # tear down VMs
```

There is no test suite in this repo — `npm run lint`/`npm run typecheck` are just `tsc` and are the only automated check.

Ansible is invoked manually after `pulumi up` (see README for the full sequence of commands to build the inventory and vars file); there's no single wrapper command.

## Architecture: `index.ts`

Single-file Pulumi program using `@pulumi/vsphere`. Key structure:

- **Data source lookups** (`getDatacenter` → `getComputeCluster`/`getDatastore`/`getNetwork`/`getVirtualMachine` for the template) are chained off `datacenter.then(...)`, since `datacenterId` is required by the others. All config for these (`datacenter`, `cluster`, `datastore`, `network`, `templateName`) is `config.require(...)` — there are no defaults, unlike the sizing knobs.
- **Cloning is not vSphere Guest Customization.** `clone: { templateUuid }` has no `customize` block. Instead, hostname/SSH-key/root-password are delivered via cloud-init through `extraConfig["guestinfo.userdata"/"guestinfo.metadata"]` (base64-encoded `#cloud-config` YAML built inline in `index.ts`). This means **the vSphere template must already have cloud-init and open-vm-tools installed** — this is a hard assumption baked into the code, not just documentation. If you ever add real vSphere guest customization (`clone.customize.linuxOptions`), remove the cloud-init `extraConfig` path rather than combining both.
- **Node naming** is positional and hardcoded: index 0 → `controlplane`, index 1 → `worker`, index ≥2 → `worker-N`. `nodeCount` beyond 2 only produces additional generically-named workers, not additional control-plane nodes.
- **IP discovery** relies on `node.defaultIpAddress`, which vSphere only populates once VMware Tools (open-vm-tools) is running and reachable — this is why open-vm-tools in the template is load-bearing, not optional.
- **Stack outputs feed the Ansible stage directly**: `ansibleInventoryLines` produces ready-to-paste inventory lines; `rootPassword`/`adminPassword` are `pulumi.secret(...)`-wrapped and must be read with `--show-secrets` when piping into the Ansible vars file (see README for the exact `pulumi stack output --json --show-secrets | python3 -c ...` step — don't try to pass secrets via plain `pulumi stack output <name>`, they'll print as `[secret]`).

## Architecture: `ansible/playbook.yml`

- Single play, targets inventory group `kube_nodes`, `become: true` throughout.
- Kubernetes version is pinned in two places that must stay in sync: `kubernetes_apt_release` (the pkgs.k8s.io release channel, e.g. `.../v1.34`) and `kubernetes_package_version` (the exact apt package version, e.g. `1.34.1-1.1`). Bumping the k8s version means editing both vars.
- Idempotency is hand-rolled via `register`/`when` checks (e.g. `containerd_config_check`, `br_netfilter_check`, `kube_pkg_check`) rather than relying purely on Ansible module idempotency — preserve this pattern when adding tasks that shell out.
- Packages are apt-`hold`-pinned after install; if you need to change the k8s version, the playbook already unholds before reinstalling (`Ensure Kubernetes packages are unheld before version pin`), so don't add a separate unhold step.
- Assumes Debian/Ubuntu (`apt`, `dpkg_selections`) — there is no OS-family branching.
- `admin_password` and `root_password` are required extra-vars (passed via `-e @/tmp/ansible-vars.json`); the playbook has no defaults for them and will fail without them.

## Config keys (Pulumi)

Required: `datacenter`, `cluster`, `datastore`, `network`, `templateName`, `sshPublicKey`.
Optional (with defaults in `index.ts`): `labelPrefix` (`kube-node`), `nodeCount` (`2`), `numCpus` (`2`), `memoryMb` (`4096`), `diskSizeGb` (`40`), `domain` (`cluster.local`), `folder`.
vSphere provider auth (`vsphere:vsphereServer`, `vsphere:user`, `vsphere:password`, `vsphere:allowUnverifiedSsl`) is provider-level config, not read in `index.ts` at all — the `@pulumi/vsphere` default provider picks it up automatically.
