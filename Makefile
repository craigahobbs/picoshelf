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


# The commit check - the scripts parse, and picovox/ is the package's lib/ at the version package-lock.json pins
.PHONY: commit
commit:
	@for file in *.js sources/*.js lib/*.js; do node --check $$file || exit 1; done
	@test "$$(node -p "require('./picovox/package.json').version")" = "$$(node -p "require('./package-lock.json').packages['node_modules/picovox'].version")" \
		|| { echo "picovox/ isn't the pinned picovox - run make picovox"; exit 1; }
	@echo "PicoShelf: scripts parse; picovox/ is picovox $$(node -p "require('./picovox/package.json').version")"


# The published site (the repository's files) into ../picoshelf.gh-pages - commit and push it from there
.PHONY: gh-pages
gh-pages: commit
	if [ ! -d ../picoshelf.gh-pages ]; then git clone -b gh-pages `git config --get remote.origin.url` ../picoshelf.gh-pages; fi
	cd ../picoshelf.gh-pages && git pull
	rsync -rv --delete --exclude=.git/ --exclude=node_modules/ ./ ../picoshelf.gh-pages


.PHONY: superclean
superclean: clean
