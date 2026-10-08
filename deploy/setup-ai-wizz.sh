#!/bin/bash
# One-time preparation of ai-wizz (10.50.1.126) for Biptrix
# (https://talk.altbetexchange.com). Run as root from a copy of deploy/:
#
#   scp -r deploy root@10.50.1.126:/root/biptrix-deploy
#   ssh root@10.50.1.126 'bash /root/biptrix-deploy/setup-ai-wizz.sh'
#
# Idempotent. It only adds things: Node.js 22 (NodeSource, same source and key
# as util2), the service and pipeline accounts, directories, the systemd units,
# the sudoers rule, the nginx vhost (reloaded only after `nginx -t`) and an
# internal-hop TLS certificate. Backups go to /root/codex-backups/biptrix-*.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
NODESOURCE_FPR="6F71F525282841EEDAF851B42F59B5F99B1BE0B4"

B=/root/codex-backups/biptrix-$(date +%Y%m%d-%H%M%S)
mkdir -p "$B"
cp -a /etc/passwd /etc/group /etc/shadow /etc/gshadow "$B/"
cp -a /etc/sudoers.d "$B/sudoers.d"
tar -czf "$B/nginx-etc.tgz" -C /etc nginx
echo "== backup in $B"

echo "== Node.js 22"
if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)' 2>/dev/null; then
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg >/dev/null
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor > /usr/share/keyrings/nodesource.gpg.new
  fpr=$(gpg --show-keys --with-colons /usr/share/keyrings/nodesource.gpg.new | awk -F: '/^fpr/{print $10; exit}')
  [ "$fpr" = "$NODESOURCE_FPR" ] || { echo "unexpected NodeSource key $fpr" >&2; rm -f /usr/share/keyrings/nodesource.gpg.new; exit 1; }
  mv /usr/share/keyrings/nodesource.gpg.new /usr/share/keyrings/nodesource.gpg
  cat > /etc/apt/sources.list.d/nodesource.sources <<'SRC'
Types: deb
URIs: https://deb.nodesource.com/node_22.x
Suites: nodistro
Components: main
Architectures: amd64
Signed-By: /usr/share/keyrings/nodesource.gpg
SRC
  apt-get update -qq
  apt-get install -y -qq nodejs >/dev/null
fi
node --version

echo "== accounts"
getent group biptrix >/dev/null || groupadd --system biptrix
# Runtime account: runs the service, owns the database and the files.
id biptrix >/dev/null 2>&1 || useradd --system -g biptrix --home-dir /var/lib/biptrix --no-create-home --shell /usr/sbin/nologin biptrix
# Pipeline account: owns the release tree; group biptrix so the service can read releases.
id biptrix-deploy >/dev/null 2>&1 || useradd --system -g biptrix --create-home --home-dir /home/biptrix-deploy --shell /bin/bash biptrix-deploy

echo "== directories"
install -d -o biptrix -g biptrix -m 0750 /var/lib/biptrix /var/lib/biptrix/files /var/lib/biptrix/backups
install -d -o biptrix-deploy -g biptrix -m 0750 /opt/biptrix /opt/biptrix/releases
install -d -o root -g biptrix -m 0750 /etc/biptrix
install -d -o root -g root -m 0700 /etc/biptrix/tls
install -d -o biptrix-deploy -g biptrix -m 0700 /home/biptrix-deploy/.ssh

echo "== units, scripts, sudoers"
install -o root -g root -m 0755 "$HERE/biptrix-install-env" /usr/local/sbin/biptrix-install-env
install -o root -g root -m 0755 "$HERE/biptrix-backup" /usr/local/sbin/biptrix-backup
install -o root -g root -m 0644 "$HERE/biptrix.service" /etc/systemd/system/biptrix.service
install -o root -g root -m 0644 "$HERE/biptrix-backup.service" /etc/systemd/system/biptrix-backup.service
install -o root -g root -m 0644 "$HERE/biptrix-backup.timer" /etc/systemd/system/biptrix-backup.timer
install -o root -g root -m 0440 "$HERE/biptrix-deploy.sudoers" /etc/sudoers.d/biptrix-deploy.new
visudo -cf /etc/sudoers.d/biptrix-deploy.new
mv /etc/sudoers.d/biptrix-deploy.new /etc/sudoers.d/biptrix-deploy
systemctl daemon-reload
systemctl enable biptrix.service >/dev/null
systemctl enable --now biptrix-backup.timer >/dev/null

echo "== pipeline SSH key for biptrix-deploy"
if [ ! -f /root/biptrix-ci-key ] && ! grep -q "gitlab-ci biptrix deploy" /home/biptrix-deploy/.ssh/authorized_keys 2>/dev/null; then
  ssh-keygen -q -t ed25519 -N "" -C "gitlab-ci biptrix deploy" -f /root/biptrix-ci-key
fi
if [ -f /root/biptrix-ci-key.pub ] && ! grep -qF "$(cut -d' ' -f2 /root/biptrix-ci-key.pub)" /home/biptrix-deploy/.ssh/authorized_keys 2>/dev/null; then
  echo "no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-user-rc $(cat /root/biptrix-ci-key.pub)" >> /home/biptrix-deploy/.ssh/authorized_keys
fi
chown biptrix-deploy:biptrix /home/biptrix-deploy/.ssh/authorized_keys
chmod 0600 /home/biptrix-deploy/.ssh/authorized_keys
[ -f /root/biptrix-ci-key ] && echo "   private key: /root/biptrix-ci-key -> GitLab CI/CD variable BIPTRIX_DEPLOY_SSH_KEY (type File), then: shred -u /root/biptrix-ci-key"

echo "== internal-hop TLS certificate"
if [ ! -f /etc/biptrix/tls/origin.key ]; then
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 \
    -subj "/CN=talk.altbetexchange.com" -addext "subjectAltName=DNS:talk.altbetexchange.com" \
    -keyout /etc/biptrix/tls/origin.key -out /etc/biptrix/tls/origin.crt 2>/dev/null
  chmod 0600 /etc/biptrix/tls/origin.key
fi

echo "== nginx vhost"
rm -f /etc/nginx/sites-enabled/default
install -o root -g root -m 0644 "$HERE/talk.altbetexchange.com.conf" /etc/nginx/sites-available/talk.altbetexchange.com.conf
ln -sfn /etc/nginx/sites-available/talk.altbetexchange.com.conf /etc/nginx/sites-enabled/talk.altbetexchange.com.conf
if nginx -t 2>&1; then
  systemctl enable nginx >/dev/null
  if systemctl is-active --quiet nginx; then systemctl reload nginx; else systemctl start nginx; fi
  echo "   nginx running"
else
  rm -f /etc/nginx/sites-enabled/talk.altbetexchange.com.conf
  echo "   nginx -t failed; vhost disabled again" >&2
  exit 1
fi

echo "== done. The service starts with the first pipeline deploy (it waits for /opt/biptrix/current)."
