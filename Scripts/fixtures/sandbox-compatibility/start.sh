#!/bin/sh
set -eu
ssh-keygen -A
mkdir -p /home/nodaltest/.ssh /run/sshd
cp /fixture/client.pub /home/nodaltest/.ssh/authorized_keys
chown -R nodaltest:nodaltest /home/nodaltest/.ssh
chmod 700 /home/nodaltest/.ssh
chmod 600 /home/nodaltest/.ssh/authorized_keys
cat > /etc/ssh/sshd_config <<'CONFIG'
Port 22
PermitRootLogin no
AllowUsers nodaltest
PasswordAuthentication yes
PubkeyAuthentication yes
AllowTcpForwarding local
PermitOpen 127.0.0.1:5432
X11Forwarding no
AllowAgentForwarding no
CONFIG
/usr/sbin/sshd
exec /usr/local/bin/docker-entrypoint.sh postgres
