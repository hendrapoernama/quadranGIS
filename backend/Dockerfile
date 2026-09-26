# ---- build ----
FROM golang:1.24-alpine AS build
WORKDIR /src
RUN apk add --no-cache git ca-certificates
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/quadrangis ./cmd/server

# ---- runtime ----
FROM alpine:3.20
# gdal-tools: ogr2ogr untuk export Esri File Geodatabase (.gdb)
RUN apk add --no-cache ca-certificates tzdata gdal-tools && adduser -D -u 10001 app
WORKDIR /app
COPY --from=build /out/quadrangis /app/quadrangis
USER app
EXPOSE 8080
ENV HTTP_ADDR=:8080
ENTRYPOINT ["/app/quadrangis"]
