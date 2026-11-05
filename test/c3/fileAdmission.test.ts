import { expect } from "chai";
import * as c3source from "@genvidtech/c3source";
import type { C3FileSection } from "@genvidtech/c3source";
import { fileAdmissionIssue, folderAdmitted } from "../../src/c3/fileAdmission.js";

const root = { atSectionRoot: true, tsTwinListed: false };
const sub = { atSectionRoot: false, tsTwinListed: false };

function issues(section: C3FileSection, names: string[]): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const n of names) out[n] = fileAdmissionIssue(section, n, root);
  return out;
}

function undefinedFor(names: string[]): Record<string, undefined> {
  return Object.fromEntries(names.map((n) => [n, undefined]));
}

describe("fileAdmission", () => {
  it("DB4-A1: admitted names return undefined", () => {
    const sound = ["a.ogg", "a.wav", "a.mp3", "a.webm"];
    const video = ["a.webm", "a.ogv", "a.mov"];
    const font = ["a.woff", "a.otf", "a.eot"];
    const icon = ["a.jpg", "a.svg"];
    expect(issues("sound", sound)).to.deep.equal(undefinedFor(sound));
    expect(issues("video", video)).to.deep.equal(undefinedFor(video));
    expect(issues("font", font)).to.deep.equal(undefinedFor(font));
    expect(issues("icon", icon)).to.deep.equal(undefinedFor(icon));
    expect(issues("general", ["a.txt"])).to.deep.equal({ "a.txt": undefined });
    expect(issues("script", ["a.js", "a.ts"])).to.deep.equal({ "a.js": undefined, "a.ts": undefined });
  });

  it("DB4-A2: refusals", () => {
    expect(fileAdmissionIssue("sound", "a.txt", root)).to.equal("category");
    expect(fileAdmissionIssue("sound", "a.mp4", root)).to.equal("category");
    expect(fileAdmissionIssue("font", "a.png", root)).to.equal("category");
    expect(fileAdmissionIssue("script", "a.txt", root)).to.equal("category");
    const twin = { atSectionRoot: true, tsTwinListed: true };
    expect({
      script: fileAdmissionIssue("script", "x.js", twin),
      general: fileAdmissionIssue("general", "x.js", twin),
    }).to.deep.equal({ script: "ts-twin", general: "ts-twin" });
    expect({
      atRoot: fileAdmissionIssue("general", "index.html", root),
      upperAtRoot: fileAdmissionIssue("general", "INDEX.HTML", root),
      atSub: fileAdmissionIssue("general", "index.html", sub),
      otherSection: fileAdmissionIssue("script", "index.html", root),
    }).to.deep.equal({
      atRoot: "reserved-root-name",
      upperAtRoot: "reserved-root-name",
      atSub: undefined,
      otherSection: "category",
    });
    expect(fileAdmissionIssue("general", ".gitkeep", root)).to.equal("name");
  });

  it("DB4-A3: .git is not admitted as a folder, Sub is", () => {
    expect({
      git: folderAdmitted("general", ".git", root),
      sub: folderAdmitted("general", "Sub", root),
      tsDefsAtRoot: folderAdmitted("script", "ts-defs", root),
      tsDefsUnderSub: folderAdmitted("script", "ts-defs", sub),
      tsDefsGeneral: folderAdmitted("general", "ts-defs", root),
    }).to.deep.equal({ git: false, sub: true, tsDefsAtRoot: false, tsDefsUnderSub: true, tsDefsGeneral: true });
  });

  it("DB4-A4: an NFD-named file is admitted, a~b.txt is not", () => {
    const nfd = "e" + String.fromCharCode(0x301) + ".txt";
    expect(nfd).to.not.equal(nfd.normalize());
    expect({
      nfd: fileAdmissionIssue("general", nfd, root),
      tilde: fileAdmissionIssue("general", "a~b.txt", root),
    }).to.deep.equal({ nfd: undefined, tilde: "name" });
  });

  it("DB4-T1: tripwire, c3source does not yet export a rescan admission predicate", () => {
    const re = /admi(t|ssion)|rescan/i;
    const matching = (names: string[]) => names.filter((n) => re.test(n));
    expect(matching(["admitsOnRescan", "fileAdmission"])).to.have.length(2);
    expect(matching(["detectFamilyMemberIssues"])).to.have.length(0);
    const hits = matching(Object.keys(c3source));
    expect(
      hits,
      `c3source now exports an admission predicate (GenvidTechnologies/c3source#130): ${hits.join(", ")}. ` +
        "Adopt it. Delete src/c3/fileAdmission.ts, its call site in src/c3/projectSync.ts, " +
        "test/c3/fileAdmission.test.ts and this tripwire. Afterwards DB4-A1, DB4-A2, DB4-A3, DB4-A4 " +
        "(moved over the adopted export), DB4-S354, DB4-S2 and DB4-S3 must stay green.",
    ).to.deep.equal([]);
  });
});
