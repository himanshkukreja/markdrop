/**
 * The /demo page of the demo stack inside a browser frame, with its video actually playing:
 * the page screenshot (player picture removed, by scenes/stills.mjs) is the background, the real
 * video frames play in the player's box, and the player's bar is redrawn on top (progress, time).
 */
import { h, seekTo, set } from "./kit.js";

export function demoPlayer(body, { shots = "../_shots", facts, width }) {
  const { rect, viewport } = facts.demo;
  const k = width / viewport.w;
  const el = h(`<div style="position:absolute;inset:0;overflow:hidden;background:#030712"></div>`);
  const pages = {}, videos = {}, canv = {};
  for (const v of ["v1", "v2"]) {
    pages[v] = h(`<img src="${shots}/demo-${v}-page.webp" style="position:absolute;left:0;top:0;width:${width}px">`);
    // Frames are drawn onto a canvas after each seek: headless Chrome doesn't always repaint a
    // paused <video> after seeking, but drawImage always reads the decoded frame.
    videos[v] = h(`<video src="${shots}/demo-${v}.mp4" muted playsinline preload="auto" style="position:absolute;left:0;top:0;width:4px;height:4px;opacity:0"></video>`);
    canv[v] = h(`<canvas width="${Math.round(rect.w * k * 2)}" height="${Math.round(rect.h * k * 2)}" style="position:absolute;left:${rect.x * k}px;top:${rect.y * k}px;width:${rect.w * k}px;height:${rect.h * k}px"></canvas>`);
    el.append(pages[v], videos[v], canv[v]);
  }
  // The bar: a strip of the page screenshot over the video, fading in from the top, then a live
  // progress line and time on top of it.
  const barTop = (viewport.h - 82) * k;
  const strip = h(`<div style="position:absolute;left:0;right:0;top:${barTop}px;height:${82 * k}px;
    background:linear-gradient(transparent, rgb(3 7 18 / .85) 45%, #030712 70%)"></div>`);
  const icons = h(`<div style="position:absolute;left:0;top:${barTop}px;width:${width}px;height:${82 * k}px;overflow:hidden">
    ${["v1", "v2"].map((v) => `<img class="pg-${v}" src="${shots}/demo-${v}-page.webp" style="position:absolute;left:0;top:${-barTop}px;width:${width}px;-webkit-mask-image:linear-gradient(transparent ${barTop}px, transparent ${barTop + 26 * k}px, #000 ${barTop + 32 * k}px);mask-image:linear-gradient(transparent ${barTop}px, transparent ${barTop + 26 * k}px, #000 ${barTop + 32 * k}px)">`).join("")}</div>`);
  const track = h(`<div style="position:absolute;left:${14 * k}px;width:${1252 * k}px;top:${694 * k}px;height:${Math.max(2, 4 * k)}px;border-radius:2px;background:rgb(255 255 255 / .28)"><i style="display:block;height:100%;border-radius:2px;background:#2b7fff"></i></div>`);
  const time = h(`<div style="position:absolute;left:${186 * k}px;top:${717 * k}px;height:${26 * k}px;padding:0 ${6 * k}px;background:#030712;color:#e5e7eb;font:500 ${14 * k}px/${26 * k}px Manrope, system-ui"></div>`);
  // The viewer's "Show details" pill floats above the picture: put it back on top.
  const pill = h(`<div style="position:absolute;left:${1080 * k}px;top:${10 * k}px;width:${192 * k}px;height:${56 * k}px;overflow:hidden">
    ${["v1", "v2"].map((v) => `<img class="pl-${v}" src="${shots}/demo-${v}-page.webp" style="position:absolute;left:${-1080 * k}px;top:${-10 * k}px;width:${width}px">`).join("")}</div>`);
  el.append(strip, icons, track, time, pill);
  body.append(el);
  return {
    el,
    /** Show version `v` at video time `vt` (seconds into the 40 s video); returns the seek promise. */
    at(v, vt) {
      for (const x of ["v1", "v2"]) { pages[x].style.display = x === v ? "" : "none"; canv[x].style.display = x === v ? "" : "none"; }
      for (const x of ["v1", "v2"]) {
        icons.querySelector(`.pg-${x}`).style.display = x === v ? "" : "none";
        pill.querySelector(`.pl-${x}`).style.display = x === v ? "" : "none";
      }
      track.firstElementChild.style.width = `${(Math.min(40, vt) / 40) * 100}%`;
      const s = Math.floor(vt);
      time.textContent = `0:${String(s).padStart(2, "0")} / 0:40`;
      const vid = videos[v], c = canv[v];
      const key = `${v}@${vt.toFixed(3)}`;
      if (c.dataset.k === key) return Promise.resolve();
      return seekTo(vid, Math.max(0, vt - 32)).then(() => {
        c.getContext("2d").drawImage(vid, 0, 0, c.width, c.height);
        c.dataset.k = key;
      });
    },
  };
}
