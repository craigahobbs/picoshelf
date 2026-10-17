# The PicoVox voice - the site's picovox/ directory is a copy of the npm package picovox's lib/ (and its package.json,
# which records the version, and LICENSE), installed at the version pinned by package-lock.json. A static site can't
# resolve bare imports, so the app imports the copy, and it's committed for GitHub Pages to serve.
.PHONY: picovox
picovox:
	npm ci
	rm -rf picovox
	mkdir -p picovox
	cp -R node_modules/picovox/lib node_modules/picovox/package.json node_modules/picovox/LICENSE picovox/
	@echo "picovox/ is picovox $$(node -p "require('./picovox/package.json').version")"


.PHONY: clean
clean:
	rm -rf node_modules
