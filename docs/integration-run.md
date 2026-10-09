# Released-package integration

Ring View Bridge supplies the Node WHEP transport, bounded session pool, and browser receiver used by [Care Handoff](https://github.com/blucca/care-handoff).

The verification sequence for version 0.1.0 is:

1. Publish the npm-format package as a versioned GitHub Release asset.
2. Install that public asset in Care Handoff and generate its browser vendor file from the installed package.
3. Run the standalone example and the consumer against the official Ring Playground.
4. Record HTTP create/delete results, decoded video frames, installed version, and consumer commit.

The [earlier Care Handoff run](https://github.com/blucca/care-handoff/blob/main/docs/ring-run.md) records its original application integration. Released-library observations are added here after the above sequence completes.
