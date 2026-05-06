# ClipVault PWA Share Test

Static PWA to test whether phone share sheet can send YouTube Shorts / Instagram Reel URLs into a webapp.

## Test on iPhone

Needs HTTPS. Local HTTP from laptop is not enough for real iPhone PWA testing.

1. Deploy this `pwa-share-test` folder to Vercel/Netlify/static host.
2. Open deployed URL in Safari on iPhone.
3. Tap Safari share button.
4. Choose `Add to Home Screen`.
5. Open ClipVault once from Home Screen.
6. Open YouTube/Instagram.
7. Share a Short/Reel link.
8. Check if `ClipVault` appears as share target.

Expected: Android Chrome likely works. iPhone likely does not show it as share target.

## Local desktop check

```bash
npx serve pwa-share-test
```

Then open the shown URL.
