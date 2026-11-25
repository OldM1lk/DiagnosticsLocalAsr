FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --onnxruntime-node-install-cuda=skip

COPY scripts ./scripts
COPY experiments/bl010/gigaam.js experiments/bl010/giga-worker.js experiments/bl010/tablet.html ./experiments/bl010/
COPY src ./src
COPY index.html ./
COPY vite.config.js ./

RUN npm run prepare-resources
ARG APP_BASE_PATH=/
ENV APP_BASE_PATH=${APP_BASE_PATH}
RUN npm run build
RUN node scripts/package-bl010.mjs

FROM nginx:stable-alpine

RUN printf 'types { text/javascript mjs; application/wasm wasm; }\n' \
    > /etc/nginx/conf.d/runtime-mime.conf

COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
