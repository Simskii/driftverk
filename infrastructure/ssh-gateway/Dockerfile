FROM golang:1.26-alpine AS build
WORKDIR /src
COPY infrastructure/ssh-gateway/go.mod infrastructure/ssh-gateway/go.sum ./
RUN go mod download all
COPY scripts/third-party-go.go /third-party-go.go
RUN go run /third-party-go.go /THIRD_PARTY_NOTICES.txt
COPY infrastructure/ssh-gateway/*.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /ssh-gateway .

FROM alpine:3.23
COPY LICENSE /usr/share/driftverk/LICENSE
RUN apk add --no-cache ca-certificates \
    && addgroup -g 1000 gateway && adduser -D -u 1000 -G gateway gateway \
    && mkdir /data && chown gateway:gateway /data
COPY --from=build /ssh-gateway /usr/local/bin/ssh-gateway
COPY --from=build /THIRD_PARTY_NOTICES.txt /usr/share/driftverk/THIRD_PARTY_NOTICES.txt
# Same UID as the former Node gateway, so its 0600 host key stays readable.
USER gateway
EXPOSE 2222 3003
ENTRYPOINT ["ssh-gateway"]
