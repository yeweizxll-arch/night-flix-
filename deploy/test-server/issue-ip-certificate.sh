#!/bin/sh
set -eu
# The public HTTP-01 connectivity check must pass first. Requires Certbot >=5.4.
test "$(hostname)" = iZbp1h5xl9g8stv73aco8mZ
/snap/bin/certbot certonly --staging --preferred-profile shortlived \
  --webroot --webroot-path /var/lib/letsencrypt --ip-address 47.110.245.29 \
  --cert-name nightflix-ip --non-interactive --agree-tos --register-unsafely-without-email \
  --config-dir /etc/letsencrypt-staging --work-dir /var/lib/letsencrypt-staging \
  --logs-dir /var/log/letsencrypt-staging
/snap/bin/certbot certonly --preferred-profile shortlived \
  --webroot --webroot-path /var/lib/letsencrypt --ip-address 47.110.245.29 \
  --cert-name nightflix-ip --non-interactive --agree-tos --register-unsafely-without-email \
  --deploy-hook '/usr/sbin/nginx -t && /bin/systemctl reload nginx'
openssl x509 -in /etc/letsencrypt/live/nightflix-ip/fullchain.pem \
  -noout -issuer -dates -ext subjectAltName
