FROM alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce

RUN apk add --no-cache samba-server=4.21.9-r1 \
  && mkdir -p /srv/axterm-share \
  && chmod 1777 /srv/axterm-share

COPY smb.conf /etc/samba/smb.conf

EXPOSE 445
CMD ["/usr/sbin/smbd", "--foreground", "--no-process-group", "--configfile=/etc/samba/smb.conf"]
