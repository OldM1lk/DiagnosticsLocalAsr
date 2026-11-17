FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY scripts ./scripts
COPY src ./src
COPY index.html ./

RUN npm run prepare-resources
RUN npm run build

FROM nginx:stable-alpine

RUN printf 'types { text/javascript mjs; application/wasm wasm; }\n' \
    > /etc/nginx/conf.d/runtime-mime.conf

COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80