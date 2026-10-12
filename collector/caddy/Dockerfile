FROM golang:1.27.0-alpine AS builder
WORKDIR /src
ENV CGO_ENABLED=0 GOTOOLCHAIN=local
COPY go.mod go.sum ./
RUN go mod download
COPY main.go ./
RUN go build -mod=readonly -trimpath -ldflags="-s -w" -o /out/caddy .

FROM caddy:2.11.7-alpine
COPY --from=builder /out/caddy /usr/bin/caddy
