# Download javascript-build
JAVASCRIPT_BUILD_DIR ?= ../javascript-build
define WGET
ifeq '$$(wildcard $(notdir $(1)))' ''
$$(info Downloading $(notdir $(1)))
$$(shell [ -f $(JAVASCRIPT_BUILD_DIR)/$(notdir $(1)) ] && cp $(JAVASCRIPT_BUILD_DIR)/$(notdir $(1)) . || $(call WGET_CMD, $(1)))
endif
endef
WGET_CMD = if command -v wget >/dev/null 2>&1; then wget -q -c $(1); else curl -f -Os $(1); fi
$(eval $(call WGET, https://craigahobbs.github.io/javascript-build/Makefile.base))
$(eval $(call WGET, https://craigahobbs.github.io/javascript-build/jsdoc.json))
$(eval $(call WGET, https://craigahobbs.github.io/javascript-build/eslint.config.js))


# The published site (make gh-pages) - the app (make app)
GHPAGES_SRC := build/app/


# Include javascript-build
USE_JSDOM := 1
include Makefile.base


# The catalog tools are linted too
ESLINT_ARGS := $(ESLINT_ARGS) tools/


clean:
	rm -rf Makefile.base jsdoc.json eslint.config.js


# superclean - also the catalog's cached pages and casts (cache/)
superclean:
	rm -rf cache


help:
	@echo '            [app|catalog|run]'


# The site, build/app/ - index.html, the app (lib/), the catalog (data/), and PicoVox (the npm package's lib/, in
# picovox/lib/). A static site can't resolve bare imports, so the app's picovox imports are made relative.
.PHONY: app
commit: app
app: build/npm.build
	rm -rf build/app/
	mkdir -p build/app/data build/app/picovox
	cp static/index.html build/app/
	cp -R lib build/app/
	cp data/catalog.json build/app/data/
	cp -R node_modules/picovox/lib node_modules/picovox/package.json node_modules/picovox/LICENSE build/app/picovox/
	for FILE in `find build/app/lib -name '*.js'`; do \
		PREFIX=`dirname $$FILE | sed -E -e 's#^build/app/##' -e 's#[^/]+#..#g'`; \
		sed -E -e "s#(['\"])picovox/#\1$$PREFIX/picovox/#g" $$FILE > $$FILE.tmp && mv $$FILE.tmp $$FILE; \
	done


# Serve the site locally - http://localhost:8000/
.PHONY: run
run: app
	python3 -m http.server --directory build/app


# The book catalog, data/catalog.json - each book's narrator cast by a local Ollama decision model (tools/voicecast.js)
.PHONY: catalog
catalog: build/npm.build
	node tools/catalog.js
