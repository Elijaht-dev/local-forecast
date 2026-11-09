import { readFile, writeFile } from "node:fs/promises";

const notices = [
  "lit/LICENSE", "lit-element/LICENSE", "lit-html/LICENSE", "@lit/reactive-element/LICENSE",
  "echarts/LICENSE", "echarts/NOTICE", "zrender/LICENSE", "tslib/LICENSE.txt",
];
const texts = await Promise.all(notices.map(async path => {
  const notice = await readFile(new URL("../node_modules/" + path, import.meta.url), "utf8");
  return path + "\n\n" + notice.trim();
}));
await writeFile(
  new URL("../custom_components/local_forecast/frontend/THIRD_PARTY_NOTICES.txt", import.meta.url),
  texts.join("\n\n----------------------------------------\n\n") + "\n",
);
