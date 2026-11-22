.PHONY: help setup dev verify build start package checksum
help:
	@echo "make setup     Install dependencies and compile the public packages"
	@echo "make dev       Start the local console and broker"
	@echo "make verify    Compile packages, check types, run tests and build Next.js"
	@echo "make build     Build the production console and packages"
	@echo "make start     Run the production console and broker"
	@echo "make package   Archive a built, clean Linux tree into dist-release/"
	@echo "make checksum  Write the .sha256 sidecar for the archive"
setup:
	npm ci
	npm run packages
dev:
	npm run dev
verify:
	npm run verify
build:
	npm run packages
	npm run build
start:
	npm start
package:
	sh scripts/package.sh
checksum:
	sh scripts/checksum.sh
