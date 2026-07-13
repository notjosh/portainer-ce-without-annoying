ARG PORTAINER_REF=portainer/portainer-ce:latest
FROM ${PORTAINER_REF} AS portainer
FROM node:24-alpine

# proxy layers first: they are identical for every tag, so they stay
# cacheable across builds; the portainer copy below differs per tag
WORKDIR /proxy
RUN npm i express@5 http-proxy-middleware@4
COPY app.js .
COPY docker-entrypoint.sh /

WORKDIR /
COPY --from=portainer . .

# docker-entrypoint.sh runs `node app.js` relative to the workdir
WORKDIR /proxy
ENTRYPOINT [ "/docker-entrypoint.sh" ]
