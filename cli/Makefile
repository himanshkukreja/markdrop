APP     := markdrop
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
LDFLAGS := -s -w -X github.com/markdrop/cli/cmd.version=$(VERSION)
OUT     := dist

.PHONY: all build install clean build-mac build-linux build-windows

all: build

## build — compile for the current platform
build:
	go build -ldflags "$(LDFLAGS)" -o $(APP) .

## install — install to $GOPATH/bin (or ~/go/bin)
install:
	go install -ldflags "$(LDFLAGS)" .

## build-all — cross-compile for all supported platforms
build-all: build-mac build-linux build-windows

build-mac:
	GOOS=darwin  GOARCH=amd64 go build -ldflags "$(LDFLAGS)" -o $(OUT)/$(APP)_darwin_amd64  .
	GOOS=darwin  GOARCH=arm64 go build -ldflags "$(LDFLAGS)" -o $(OUT)/$(APP)_darwin_arm64  .

build-linux:
	GOOS=linux   GOARCH=amd64 go build -ldflags "$(LDFLAGS)" -o $(OUT)/$(APP)_linux_amd64   .
	GOOS=linux   GOARCH=arm64 go build -ldflags "$(LDFLAGS)" -o $(OUT)/$(APP)_linux_arm64   .

build-windows:
	GOOS=windows GOARCH=amd64 go build -ldflags "$(LDFLAGS)" -o $(OUT)/$(APP)_windows_amd64.exe .
	GOOS=windows GOARCH=arm64 go build -ldflags "$(LDFLAGS)" -o $(OUT)/$(APP)_windows_arm64.exe .

## clean — remove build artifacts
clean:
	rm -rf $(OUT) $(APP)

## test — run unit tests
test:
	go test ./...

## tidy — sync go.mod / go.sum
tidy:
	go mod tidy
