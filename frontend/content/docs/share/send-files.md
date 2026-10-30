---
title: Send files peer to peer
description: Send files of any size straight from your device to someone else's, encrypted, with nothing stored on Markdrop's servers. No account needed.
updated: 2026-10-30
keywords: [p2p, peer to peer, send file, transfer, webrtc, large file, airdrop, share link, qr code]
---

Send lets you hand files straight to someone else's device. You drop files, share a link, and they stream from your device to theirs, encrypted, with no copy left on any server. Neither of you needs an account.

It's different from [publishing a file](/get-started/first-file): a published file lives on Markdrop and anyone with access can open it later. A peer-to-peer transfer exists only while your tab is open.

| | Send peer to peer | Publish a file |
| --- | --- | --- |
| Where the file lives | On your device | On Markdrop |
| Size | Any size | Up to 25 MB, or 2 GB for video and audio |
| Works when you close the tab | No | Yes |

## Send files

::::steps
### Open Send a file
Go to [markdrop.in/share](https://markdrop.in/share).

### Add your files
Drop files or a whole folder onto the page, or choose **Choose files** or **Choose a folder**. Any type, any size. Nothing leaves your device until someone opens the link.

### Share the link
Choose **Copy link** (or **Share…** on devices that have it), or let them scan the QR code with a phone camera.

### Keep the tab open
The files come from your device, so keep the tab open until everyone has what they need. Closing it ends the share.
::::

While you're sharing, the page shows who's connected under **People**, with up to 10 at once, and how far each one has got. Forgot something? Drop more files on the page or choose **Add files**; everyone connected sees them right away.

![The Sharing 2 files page: the share link with Copy link and Share…, a QR code, the Right now map, and People listing an iPhone and a Windows PC, each with a Direct badge, a progress bar and a percentage.](/docs-assets/share/send-files/p2p-sender.webp "Each person picks what to download: the iPhone is getting both files, the PC only the video.")

When you're done, choose **End sharing**. The link stops working. If people are still downloading, Markdrop asks first; they keep what they've already saved.

## Receive files

Open the link. Markdrop connects your device to the sender's, then shows the files.

![The receiving page on a phone: 2 files are ready, with a Direct badge between Their device and This device, Q3 report.pdf and demo-notes.txt each with a download button, and Download all 2 at the bottom.](/docs-assets/share/send-files/p2p-receiver.webp)

- Choose **Download all** to get everything, or **Save** next to a single file.
- On a computer, each file saves to your Downloads as it arrives. If your browser asks to download multiple files, choose **Allow**.
- On an iPhone, files collect in the page as they arrive, then one tap saves them to Photos or Files.

The sender's tab must stay open while you download. If they close it, anything you already saved is yours to keep.

## Use the terminal

The [Markdrop CLI](/cli/send-and-receive) sends and receives too, and it works with the browser in both directions.

```bash title="Receive from a browser link"
markdrop get https://markdrop.in/share/<id>
```

```bash title="Send a file or a folder"
markdrop send ./report.pdf
```

The CLI writes straight to disk, so very large files are easier to receive there than in a browser. A CLI sender serves one recipient at a time.

## How it stays private

- **Your files are never stored on Markdrop's servers.** They go from one device to the other.
- **Encrypted in transit.** The connection between the two devices is encrypted with DTLS, the standard encryption for browser-to-browser connections.
- **Direct when the network allows.** When two networks can't reach each other directly, an encrypted relay forwards the bytes. The relay can't read them. The page shows **Direct** or **Relayed** while a file is moving.

::clip{src="/docs-assets/share/send-files/p2p-direct-vs-relay" alt="Animation: Markdrop's server introduces two devices, then files flow directly between them; on a blocked network the encrypted bytes go through a relay that can't read them, and the badge changes from Direct to Relayed." theme="light"}

Markdrop's server introduces the two devices to each other. It keeps the name, type and size of the files, how many there were, a hashed IP address, your account if you're signed in, and connection details (route, timing, browser). Choose **What we record** on the page to see this list.

:::note
Files inside a folder you drop are sent as separate files. Between two browsers, the folder structure isn't kept. Between two CLIs, a folder arrives as a folder.
:::

## Watch it once

::video{id="send-files-p2p" title="Send a file from a laptop to a phone" duration="0:31"}
