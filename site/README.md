# site/

The product page and the documentation, published to GitHub Pages by `.github/workflows/pages.yml`
on every push to `master` that touches this folder. Static: no generator, no build step.

    index.html   the product
    docs.html    the manual
    style.css    both, using the app's own tokens and typefaces
    shots/       screenshots of the running app

## Regenerating the screenshots

They are photographs of the real app, taken against invented data. This repo is public and the
release dmg ships the whole payload, so a screenshot of a real database would publish meeting
titles, people and browsing history with it. `scripts/demo-seed.mjs` builds the world they are
taken in: a fictional platform team mid-migration, with dates relative to the day it runs.

```sh
DEMO=/tmp/sb-demo
rm -rf "$DEMO" && mkdir -p "$DEMO/files"
ln -s "$HOME/Library/Application Support/second-brain/models" "$DEMO/models"   # don't re-download

# once, so the app creates and migrates the database
SB_DATA_DIR="$DEMO" npx next start -p 4142 &
curl -sf http://localhost:4142/api/home >/dev/null && kill %1

node scripts/demo-seed.mjs "$DEMO"
SB_DATA_DIR="$DEMO" npx next start -p 4142 &
```

Then photograph it. Chrome's own headless mode writes the file, so nothing needs installing:

```sh
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
"$CHROME" --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
  --window-size=1440,900 --virtual-time-budget=9000 \
  --screenshot=site/shots/home.png http://localhost:4142/
```

`sips -Z 2000` brings them down to the size the page uses. If the capture happens a while after
the seed, `node scripts/demo-seed.mjs "$DEMO" --touch` refreshes the activity helper's heartbeat
so the "not recording" banner stays away.
