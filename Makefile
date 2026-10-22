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


# The catalog tools are linted and covered too, and the service worker is linted
ESLINT_ARGS := $(ESLINT_ARGS) tools/ static/sw.js
C8_ARGS := $(C8_ARGS) --src tools/


clean:
	rm -rf Makefile.base jsdoc.json eslint.config.js


# superclean - also the catalog's cached pages and casts (cache/)
superclean:
	rm -rf cache


help:
	@echo '            [app|catalog|run]'


# The site, build/app/ - index.html and its icons and manifest (static/), the app (lib/), the catalog (data/), PicoVox
# (the npm package's lib/, in picovox/lib/), and the service worker (sw.js - the site offline). A static site can't resolve bare imports, so the
# app's picovox imports are made relative.
.PHONY: app
commit: app
app: build/npm.build
	rm -rf build/app/
	mkdir -p build/app/data build/app/picovox
	cp static/index.html static/icon.svg static/*.png static/manifest.webmanifest build/app/
	cp -R lib build/app/
	cp data/catalog.json build/app/data/
	cp -R node_modules/picovox/lib node_modules/picovox/package.json node_modules/picovox/LICENSE build/app/picovox/
	for FILE in `find build/app/lib -name '*.js'`; do \
		PREFIX=`dirname $$FILE | sed -E -e 's#^build/app/##' -e 's#[^/]+#..#g'`; \
		sed -E -e "s#(['\"])picovox/#\1$$PREFIX/picovox/#g" $$FILE > $$FILE.tmp && mv $$FILE.tmp $$FILE; \
	done
	cp static/sw.js build/app/
	$(NODE_SHELL) node --input-type=module -e "$$SERVICE_WORKER_SCRIPT"


# The service worker's version (a hash of the site's files) and files (the index as "./")
define SERVICE_WORKER_SCRIPT
import {readFileSync, readdirSync, statSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const files = readdirSync('build/app', {'recursive': true}).
    filter((file) => file !== 'sw.js' && statSync(`build/app/$${file}`).isFile()).sort();
const hash = createHash('sha256');
for (const file of files) {
    hash.update(file).update(readFileSync(`build/app/$${file}`));
}
const urls = files.map((file) => (file === 'index.html' ? './' : file));
const worker = readFileSync('build/app/sw.js', 'utf-8').
    replace("const version = 'development';", `const version = '$${hash.digest('hex').slice(0, 16)}';`).
    replace('const files = [];', `const files = $${JSON.stringify(urls)};`);
writeFileSync('build/app/sw.js', worker);
endef
export SERVICE_WORKER_SCRIPT


# Serve the site locally - http://localhost:8000/
.PHONY: run
run: app
	python3 -m http.server --directory build/app


# The icon's PNGs (static/*.png - the home screen's, the manifest's, and the favicon's fallback), rendered from
# static/icon.svg by headless Chrome (CHROME) - after changing the icon. The home screen's and the manifest's are full
# squares (the system rounds them), the maskable one's icon at 80% (in Android's safe zone).
CHROME ?= /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
ICON_RENDERS := favicon-32:32:32:transparent apple-touch-icon:180:180:%23e49a62 icon-192:192:192:%23e49a62 \
	icon-512:512:512:%23e49a62 icon-maskable-512:512:410:%23e49a62

.PHONY: icons
icons:
	rm -rf build/icons
	mkdir -p build/icons
	cp static/icon.svg build/icons/
	for RENDER in $(ICON_RENDERS); do \
		NAME=`echo $$RENDER | cut -d: -f1`; SIZE=`echo $$RENDER | cut -d: -f2`; ICON=`echo $$RENDER | cut -d: -f3`; \
		BACKGROUND=`echo $$RENDER | cut -d: -f4 | sed 's/%23/#/'`; \
		printf '<!doctype html><html style="margin:0;background:%s"><body style="margin:0;width:%spx;height:%spx;display:grid;place-items:center"><img src="icon.svg" style="width:%spx;height:%spx;display:block"></body></html>' \
			"$$BACKGROUND" $$SIZE $$SIZE $$ICON $$ICON > build/icons/$$NAME.html; \
		"$(CHROME)" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --window-size=$$SIZE,$$SIZE \
			--default-background-color=00000000 --screenshot=static/$$NAME.png "file://$(CURDIR)/build/icons/$$NAME.html"; \
	done


# The book catalog, data/catalog.json - each book's narrator cast by a local Ollama decision model (tools/voicecast.js)
.PHONY: catalog
catalog: build/npm.build
	node tools/catalog.js
