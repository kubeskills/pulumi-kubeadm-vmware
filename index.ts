import * as pulumi from "@pulumi/pulumi";
import * as vsphere from "@pulumi/vsphere";
import * as random from "@pulumi/random";

const config = new pulumi.Config();

const datacenterName = config.require("datacenter");
const clusterName = config.require("cluster");
const datastoreName = config.require("datastore");
const networkName = config.require("network");
const templateName = config.require("templateName");
const sshPublicKey = config.require("sshPublicKey");

const labelPrefix = config.get("labelPrefix") ?? "kube-node";
const nodeCount = config.getNumber("nodeCount") ?? 2;
const numCpus = config.getNumber("numCpus") ?? 2;
const memoryMb = config.getNumber("memoryMb") ?? 4096;
const diskSizeGb = config.getNumber("diskSizeGb") ?? 40;
const domain = config.get("domain") ?? "cluster.local";
const folder = config.get("folder");

const datacenter = vsphere.getDatacenter({ name: datacenterName });
const cluster = datacenter.then((dc) =>
    vsphere.getComputeCluster({ name: clusterName, datacenterId: dc.id }),
);
const datastore = datacenter.then((dc) =>
    vsphere.getDatastore({ name: datastoreName, datacenterId: dc.id }),
);
const network = datacenter.then((dc) =>
    vsphere.getNetwork({ name: networkName, datacenterId: dc.id }),
);
const template = datacenter.then((dc) =>
    vsphere.getVirtualMachine({ name: templateName, datacenterId: dc.id }),
);

const rootPasswordResource = new random.RandomPassword("vm-root-password", {
    length: 20,
    minLower: 1,
    minUpper: 1,
    minNumeric: 1,
    minSpecial: 1,
    overrideSpecial: "!@#$%^&*()-_=+[]{}<>?",
});
const rootPasswordSecret = pulumi.secret(rootPasswordResource.result);

const adminPasswordResource = new random.RandomPassword("admin-password", {
    length: 20,
    minLower: 1,
    minUpper: 1,
    minNumeric: 1,
    minSpecial: 1,
    overrideSpecial: "!@#$%^&*()-_=+[]{}<>?",
});
const adminPasswordSecret = pulumi.secret(adminPasswordResource.result);

// The template is expected to be a cloud-init enabled Linux image (e.g. an
// Ubuntu cloud image) with open-vm-tools installed, so that cloud-init can
// pick up its user-data/metadata from the VMware "guestinfo" datasource.
const cloudInitUserData = pulumi
    .all([sshPublicKey, rootPasswordSecret])
    .apply(([key, rootPassword]) =>
        Buffer.from(
            `#cloud-config
ssh_pwauth: true
disable_root: false
chpasswd:
  expire: false
users:
  - name: root
    lock_passwd: false
    ssh_authorized_keys:
      - ${key}
runcmd:
  - echo "root:${rootPassword}" | chpasswd
`,
        ).toString("base64"),
    );

const nodes: vsphere.VirtualMachine[] = [];
const hostnames: string[] = [];

for (let i = 0; i < nodeCount; i++) {
    const hostname = i === 0 ? "controlplane" : i === 1 ? "worker" : `worker-${i}`;
    hostnames.push(hostname);

    const cloudInitMetaData = Buffer.from(
        `instance-id: ${hostname}\nlocal-hostname: ${hostname}\n`,
    ).toString("base64");

    nodes.push(
        new vsphere.VirtualMachine(`${labelPrefix}-${i + 1}`, {
            name: hostname,
            resourcePoolId: cluster.then((c) => c.resourcePoolId),
            datastoreId: datastore.then((d) => d.id),
            folder,
            numCpus,
            memory: memoryMb,
            guestId: template.then((t) => t.guestId),
            scsiType: template.then((t) => t.scsiType),
            networkInterfaces: [
                {
                    networkId: network.then((n) => n.id),
                    adapterType: template.then((t) => t.networkInterfaceTypes[0]),
                },
            ],
            disks: [
                {
                    label: "Hard Disk 1",
                    size: diskSizeGb,
                    thinProvisioned: template.then((t) => t.disks[0]?.thinProvisioned),
                },
            ],
            clone: {
                templateUuid: template.then((t) => t.id),
            },
            extraConfig: {
                "guestinfo.userdata": cloudInitUserData,
                "guestinfo.userdata.encoding": "base64",
                "guestinfo.metadata": cloudInitMetaData,
                "guestinfo.metadata.encoding": "base64",
            },
        }),
    );
}

interface NodeDetails {
    hostname: string;
    id: string;
    ipAddress: string;
}

const nodeDetailsOutputs: pulumi.Output<NodeDetails>[] = nodes.map((node, index) =>
    pulumi.all([node.id, node.defaultIpAddress]).apply(([id, ipAddress]) => ({
        hostname: hostnames[index],
        id,
        ipAddress,
    })),
);

const nodeDetailsAll = pulumi.all(nodeDetailsOutputs);

export const nodeDetails = nodeDetailsAll;

export const instanceIds = nodeDetailsAll.apply((details) => details.map((detail) => detail.id));

export const ipAddresses = nodeDetailsAll.apply((details) =>
    details.map((detail) => ({
        hostname: detail.hostname,
        ip: detail.ipAddress,
    })),
);

export const controlplaneIp = nodeDetailsAll.apply(
    (details) => details.find((d) => d.hostname === "controlplane")?.ipAddress,
);

export const workerIp = nodeDetailsAll.apply(
    (details) => details.find((d) => d.hostname === "worker")?.ipAddress,
);

export const ansibleInventoryLines = nodeDetailsAll.apply((details) =>
    details.map(
        (detail) =>
            `${detail.hostname} ansible_host=${detail.ipAddress} ansible_user=root node_hostname=${detail.hostname}`,
    ),
);

export const rootPassword = rootPasswordSecret;
export const adminPassword = adminPasswordSecret;
