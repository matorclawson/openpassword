.PHONY: help setup dev verify build start
help:
	@echo "make setup     Install dependencies and compile the public packages"
	@echo "make dev       Start the local console and broker"
	@echo "make verify    Compile packages, check types, run tests and build Next.js"
	@echo "make build     Build the production console and packages"
	@echo "make start     Run the production console and broker"
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

.PHONY: install-cli
install-cli: packages/cli/dist/index.js
	mkdir -p "$(HOME)/.local/bin"
	chmod +x packages/cli/dist/index.js
	ln -sfn "$(CURDIR)/packages/cli/dist/index.js" "$(HOME)/.local/bin/openpassword"
