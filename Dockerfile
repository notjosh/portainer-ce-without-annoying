ARG PORTAINER_REF=portainer/portainer-ce:latest
FROM ${PORTAINER_REF} AS portainer
FROM node:24-alpine

WORKDIR /
COPY --from=portainer . .

WORKDIR /proxy

RUN npm i express http-proxy-middleware
COPY app.js .

COPY docker-entrypoint.sh /

ENTRYPOINT [ "/docker-entrypoint.sh" ]
