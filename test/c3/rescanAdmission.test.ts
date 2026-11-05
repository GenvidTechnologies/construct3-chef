import { expect } from "chai";
import { rescanIssue } from "../../src/c3/rescanAdmission.js";
import type { RescanEntry } from "@genvidtech/c3source";

const file = (name: string, extra: Partial<RescanEntry> = {}): RescanEntry => ({
  kind: "file",
  name,
  atSectionRoot: true,
  ...extra,
});
const noTwin = { hasRegisteredFile: () => false };
const SECTION = { kind: "section" };

describe("rescanAdmission", () => {
  it("CS41-U1: rescanIssue admits and refuses per section", () => {
    const actual = {
      script: [rescanIssue("script", file("a.js", noTwin)), rescanIssue("script", file("a.txt", noTwin))],
      sound: [rescanIssue("sound", file("a.wav")), rescanIssue("sound", file("a.txt"))],
      music: [rescanIssue("music", file("a.mp3")), rescanIssue("music", file("a.png"))],
      video: [rescanIssue("video", file("a.mp4")), rescanIssue("video", file("a.txt"))],
      font: [
        rescanIssue("font", file("a.woff2")),
        rescanIssue("font", file("a.ttf")),
        rescanIssue("font", file("a.png")),
      ],
      icon: [rescanIssue("icon", file("a.jpg")), rescanIssue("icon", file("a.ogg"))],
      general: [rescanIssue("general", file("a.txt", noTwin)), rescanIssue("general", file("data.json", noTwin))],
    };
    expect(actual).to.deep.equal({
      script: [undefined, SECTION],
      sound: [undefined, SECTION],
      music: [undefined, SECTION],
      video: [undefined, SECTION],
      font: [undefined, undefined, SECTION],
      icon: [undefined, SECTION],
      general: [undefined, { kind: "reserved-root-name" }],
    });
  });

  it("CS41-U2: script admits .ts in any letter case, still refuses a bad name and other sections", () => {
    expect({
      ts: rescanIssue("script", file("a.ts")),
      upperTs: rescanIssue("script", file("A.TS")),
      badName: rescanIssue("script", file("a~b.ts")),
      tsx: rescanIssue("script", file("a.tsx")),
      soundTs: rescanIssue("sound", file("a.ts")),
    }).to.deep.equal({
      ts: undefined,
      upperTs: undefined,
      badName: { kind: "name" },
      tsx: SECTION,
      soundTs: SECTION,
    });
  });

  it("CS41-U3: an unknown section key gets the name check only and never throws", () => {
    for (const key of ["custom", "toString"]) {
      expect(
        {
          js: rescanIssue(key, file("a.js")),
          index: rescanIssue(key, file("index.html")),
          badName: rescanIssue(key, file("a~b.txt")),
          folder: rescanIssue(key, { kind: "folder", name: "ts-defs", atSectionRoot: true }),
        },
        key,
      ).to.deep.equal({ js: undefined, index: undefined, badName: { kind: "name" }, folder: undefined });
    }
  });
});
