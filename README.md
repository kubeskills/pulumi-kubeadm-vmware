# Create Kubeadm Cluster on VMware with Pulumi

This Pulumi program provisions two VMware vSphere virtual machines (or a configurable count) by cloning them from an existing vSphere template. After the infrastructure is created, run the included Ansible playbook to install and hold `kubectl`, `kubeadm`, and `kubelet`, leaving each node ready for a kubeadm-managed Kubernetes cluster.

See also: [pulumi-kubeadm-linode](https://github.com/kubeskills/pulumi-kubeadm-linode) for the equivalent setup on Linode.

## Prerequisites
- Access to a vCenter Server (cloning requires vCenter; it is not supported on direct ESXi host connections).
- Pulumi CLI configured with vSphere credentials (`vsphere:vsphereServer`, `vsphere:user`, `vsphere:password` config, or the `VSPHERE_SERVER` / `VSPHERE_USER` / `VSPHERE_PASSWORD` environment variables).
- A VM template already present in vCenter:
  - A cloud-init-enabled Linux image (for example, an imported Ubuntu 22.04 cloud image) with `open-vm-tools` installed, so cloud-init can read its configuration from the VMware `guestinfo` datasource.
  - VMware Tools running so the provider can report the guest IP address.
- Node.js 18+ and npm.
- An SSH key pair whose public key you want authorized on each VM.
- Ansible 2.14+ (or later) for post-provision configuration.

## Setup
```bash
npm install
pulumi stack init kubeadm-dev  # or reuse an existing stack

# vSphere provider credentials
pulumi config set vsphere:vsphereServer vcenter.example.com
pulumi config set vsphere:user administrator@vsphere.local --secret
pulumi config set vsphere:password <your-vsphere-password> --secret
pulumi config set vsphere:allowUnverifiedSsl true   # only if using a self-signed vCenter certificate

# Program configuration
pulumi config set datacenter dc-01
pulumi config set cluster cluster-01
pulumi config set datastore datastore-01
pulumi config set network "VM Network"
pulumi config set templateName ubuntu-22.04-cloudinit-template
pulumi config set sshPublicKey "$(cat ~/.ssh/id_rsa.pub)"

# Optional overrides
pulumi config set labelPrefix kube-node
pulumi config set nodeCount 2
pulumi config set numCpus 2
pulumi config set memoryMb 4096
pulumi config set diskSizeGb 40
pulumi config set domain cluster.local
pulumi config set folder kubeadm-vms
```

## Deploy
```bash
pulumi up
```

Exports include VM IDs and IP addresses (labeled by hostname). The `ansibleInventoryLines` export prints helper lines (`hostname ansible_host=IP`) you can paste into an Ansible inventory file.

Each VM is cloned from the configured `templateName`, sized with `numCpus`/`memoryMb`/`diskSizeGb`, and attached to the configured `network`. Cloud-init configuration is passed to the guest through the vSphere `guestinfo` mechanism (`extraConfig`), authorizing the supplied `sshPublicKey` for `root` and setting a randomly generated root password.

After `pulumi up`, configure the nodes with Ansible using the playbook at `ansible/playbook.yml`:

```bash
# Start from the provided inventory template
cp ansible/inventory.example.ini ansible/inventory.ini

# Append the stack output inventory lines under the kube_nodes group
pulumi stack output ansibleInventoryLines --json | jq -r '.[]' >> ansible/inventory.ini

# Edit ansible/inventory.ini if you need to adjust hostnames or SSH users
[kube_nodes]
controlplane ansible_host=192.168.1.10 ansible_user=root node_hostname=controlplane
worker ansible_host=192.168.1.11 ansible_user=root node_hostname=worker

# Write passwords to a JSON vars file (avoids shell mangling of special characters)
pulumi stack output --json --show-secrets | python3 -c "
import json, sys
data = json.load(sys.stdin)
print(json.dumps({'root_password': data['rootPassword'], 'admin_password': data['adminPassword']}))
" > /tmp/ansible-vars.json

# Run the playbook
ansible-playbook ansible/playbook.yml -e @/tmp/ansible-vars.json

# Clean up
rm /tmp/ansible-vars.json
```

The root-level `ansible.cfg` disables host key checking for first-run convenience and defaults the inventory to `ansible/inventory.ini`. Adjust these settings as needed for your environment after the initial configuration.

### What the playbook does

The playbook targets all hosts in the `kube_nodes` inventory group and runs every task as root (`become: true`).

#### 1. APT prerequisites and Kubernetes repository setup

- Installs baseline packages needed for secure APT downloads: `apt-transport-https`, `ca-certificates`, `curl`, and `gnupg`.
- Creates the `/etc/apt/keyrings` directory and downloads the Kubernetes v1.34 repository signing key.
- Converts the key from ASCII-armored format to GPG binary format with `gpg --dearmor`.
- Adds the Kubernetes APT source list pointing at the v1.34 stable repository.
- Refreshes the APT cache so the new repository is available.

#### 2. Container runtime (containerd)

- Installs the `containerd` package.
- Generates the default containerd configuration, then patches it to enable the systemd cgroup driver (`SystemdCgroup = true`) and set the sandbox (pause) image to `registry.k8s.io/pause:3.10`. This step is skipped if the configuration already has the correct values.
- Enables and starts the containerd service. If the configuration was changed, containerd is restarted via a handler.

#### 3. Kernel and networking prerequisites

- Enables IPv4 forwarding (`net.ipv4.ip_forward = 1`) via sysctl.
- Loads the `br_netfilter` kernel module (required for Kubernetes networking) and persists it in `/etc/modules-load.d/k8s.conf` so it loads on boot.
- Configures bridge networking sysctl values (`net.bridge.bridge-nf-call-iptables` and `net.bridge.bridge-nf-call-ip6tables`) so that iptables can see bridged traffic.
- Reloads all sysctl settings to apply changes immediately.

#### 4. Kubernetes component installation

- Unholds any previously held Kubernetes packages so APT can upgrade them if needed.
- Installs `kubelet`, `kubeadm`, and `kubectl` pinned to version `1.34.1-1.1`.
- Verifies that all three binaries are present on the system.
- Holds the packages at their current version to prevent unintended upgrades.
- Enables and starts the kubelet service.

#### 5. Node configuration

- Sets the hostname on each node when the `node_hostname` inventory variable is provided (e.g., `controlplane` or `worker`).
- Disables swap, which is a requirement for kubelet to run.

#### 6. SSH and user setup

- Enables SSH password authentication by setting `PasswordAuthentication yes` in `/etc/ssh/sshd_config`.
- Permits root login with a password by setting `PermitRootLogin yes`.
- Creates an `admin` user with a home directory, bash shell, and membership in the `sudo` group.
- Sets the admin user's password from the Pulumi-generated `admin_password` variable.
- Flushes handlers to restart sshd immediately so the configuration takes effect before the playbook finishes.

#### 7. Credential display

- Prints each node's public IP address, root password, and admin password at the end of the run so you have the connection details in one place.

## Cleanup
When you are finished, remove the resources with:
```bash
pulumi destroy
```
