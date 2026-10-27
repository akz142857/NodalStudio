FROM postgres:17-alpine
RUN apk add --no-cache openssh && adduser -D nodaltest && echo 'nodaltest:nodal-sandbox-fixture-only' | chpasswd
COPY start.sh /fixture-start.sh
ENTRYPOINT ["/bin/sh", "/fixture-start.sh"]
