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

  const names = (section: string, list: string[]): Record<string, unknown> =>
    Object.fromEntries(list.map((n) => [n, rescanIssue(section, file(n, noTwin))]));
  const undefinedFor = (list: string[]): Record<string, undefined> =>
    Object.fromEntries(list.map((n) => [n, undefined]));
  const folder = (name: string, atSectionRoot: boolean): RescanEntry => ({ kind: "folder", name, atSectionRoot });

  it("DB4-A1: admitted names return undefined", () => {
    const sound = ["a.ogg", "a.wav", "a.mp3", "a.webm"];
    const video = ["a.webm", "a.ogv", "a.mov"];
    const font = ["a.woff", "a.otf", "a.eot"];
    const icon = ["a.jpg", "a.svg"];
    expect(names("sound", sound)).to.deep.equal(undefinedFor(sound));
    expect(names("video", video)).to.deep.equal(undefinedFor(video));
    expect(names("font", font)).to.deep.equal(undefinedFor(font));
    expect(names("icon", icon)).to.deep.equal(undefinedFor(icon));
    expect(names("general", ["a.txt"])).to.deep.equal({ "a.txt": undefined });
    expect(names("script", ["a.js", "a.ts"])).to.deep.equal({ "a.js": undefined, "a.ts": undefined });
  });

  it("DB4-A2: refusals", () => {
    expect(rescanIssue("sound", file("a.txt"))).to.deep.equal(SECTION);
    expect(rescanIssue("sound", file("a.mp4"))).to.deep.equal(SECTION);
    expect(rescanIssue("font", file("a.png"))).to.deep.equal(SECTION);
    expect(rescanIssue("script", file("a.txt", noTwin))).to.deep.equal(SECTION);
    const twin = { hasRegisteredFile: () => true };
    expect({
      script: rescanIssue("script", file("x.js", twin)),
      general: rescanIssue("general", file("x.js", twin)),
    }).to.deep.equal({ script: { kind: "ts-twin" }, general: { kind: "ts-twin" } });
    expect({
      atRoot: rescanIssue("general", file("index.html", noTwin)),
      upperAtRoot: rescanIssue("general", file("INDEX.HTML", noTwin)),
      atSub: rescanIssue("general", file("index.html", { ...noTwin, atSectionRoot: false })),
      otherSection: rescanIssue("script", file("index.html", noTwin)),
    }).to.deep.equal({
      atRoot: { kind: "reserved-root-name" },
      upperAtRoot: { kind: "reserved-root-name" },
      atSub: undefined,
      otherSection: SECTION,
    });
    expect(rescanIssue("general", file(".gitkeep", noTwin))).to.deep.equal({ kind: "name" });
  });

  it("DB4-A3: .git is not admitted as a folder, Sub is", () => {
    expect({
      git: rescanIssue("general", folder(".git", true)),
      sub: rescanIssue("general", folder("Sub", true)),
      tsDefsAtRoot: rescanIssue("script", folder("ts-defs", true)),
      tsDefsUnderSub: rescanIssue("script", folder("ts-defs", false)),
      tsDefsGeneral: rescanIssue("general", folder("ts-defs", true)),
    }).to.deep.equal({
      git: { kind: "name" },
      sub: undefined,
      tsDefsAtRoot: { kind: "ts-defs" },
      tsDefsUnderSub: undefined,
      tsDefsGeneral: undefined,
    });
  });

  it("DB4-A4: an NFD-named file is admitted, a~b.txt is not", () => {
    const nfd = "e" + String.fromCharCode(0x301) + ".txt";
    expect(nfd).to.not.equal(nfd.normalize());
    expect({
      nfd: rescanIssue("general", file(nfd, noTwin)),
      tilde: rescanIssue("general", file("a~b.txt", noTwin)),
    }).to.deep.equal({ nfd: undefined, tilde: { kind: "name" } });
  });
});
