FROM lscr.io/linuxserver/openssh-server@sha256:39ba37d50fdd6be1bf70644c871e5dcb9234ee79ac56424ea03ca08cadf1e7b0

RUN sed -i 's/^AllowTcpForwarding no/AllowTcpForwarding yes/' /etc/ssh/sshd_config \
  && sed -i 's/^X11Forwarding no/X11Forwarding yes/' /etc/ssh/sshd_config \
  && printf '#!/bin/sh\nexit 0\n' >/usr/bin/xauth \
  && chmod 0755 /usr/bin/xauth
