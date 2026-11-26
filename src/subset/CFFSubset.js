import Subset from './Subset';
import CFFTop from '../cff/CFFTop';
import CFFPrivateDict from '../cff/CFFPrivateDict';
import collectCFFSubrReferences from '../cff/CFFSubrReferences';
import standardStrings from '../cff/CFFStandardStrings';

const RETURN_SUBR = new Uint8Array([11]);

export default class CFFSubset extends Subset {
  constructor(font) {
    super(font);

    this.cff = this.font['CFF '];
    if (!this.cff) {
      throw new Error('Not a CFF Font');
    }

    this.glyphFDs = [];
    this.localSubrUsage = {};
    this.subrUsageByFD = {};
  }

  subsetCharstrings() {
    this.charstrings = [];
    this.glyphFDs = [];
    this.globalSubrUsage = {};
    this.localSubrUsage = {};
    this.subrUsageByFD = {};
    let gsubrs = this.globalSubrUsage;

    for (let gid of this.glyphs) {
      this.charstrings.push(this.cff.getCharString(gid));

      // One charstring walk discovers both local and global subroutine refs.
      // Local refs are aggregated immediately by FD, avoiding a second outline
      // walk in subsetFontdict and per-glyph usage objects.
      let fd = this.cff.fdForGlyph(gid);
      this.glyphFDs.push(fd);

      let usedSubrs;
      if (fd == null) {
        usedSubrs = this.localSubrUsage;
      } else {
        usedSubrs = this.subrUsageByFD[fd] || {};
        this.subrUsageByFD[fd] = usedSubrs;
      }

      collectCFFSubrReferences(this.cff, gid, {
        usedSubrs,
        usedGlobalSubrs: gsubrs,
      });
    }

    this.gsubrs = this.subsetSubrs(this.cff.globalSubrIndex, gsubrs);
  }

  subsetSubrs(subrs, used) {
    let res = [];
    for (let i = 0; i < subrs.length; i++) {
      let subr = subrs[i];
      if (used[i]) {
        this.cff.stream.pos = subr.offset;
        res.push(this.cff.stream.readBuffer(subr.length));
      } else {
        // Every unused slot still exists. Sharing the return byte is safe;
        // the INDEX offsets preserve this subroutine's original call number.
        res.push(RETURN_SUBR);
      }
    }

    return res;
  }

  subsetFontdict(topDict) {
    topDict.FDArray = [];
    topDict.FDSelect = {
      version: 0,
      fds: [],
    };

    let used_subrs = [];
    let fd_select = {};
    for (let i = 0; i < this.glyphs.length; i++) {
      let fd = this.glyphFDs[i];
      if (fd == null) {
        continue;
      }

      if (fd_select[fd] == null) {
        fd_select[fd] = topDict.FDArray.length;
        topDict.FDArray.push(Object.assign({}, this.cff.topDict.FDArray[fd]));
        used_subrs.push(this.subrUsageByFD[fd] || {});
      }

      topDict.FDSelect.fds.push(fd_select[fd]);
    }

    for (let i = 0; i < topDict.FDArray.length; i++) {
      let dict = topDict.FDArray[i];
      delete dict.FontName;
      if (dict.Private && dict.Private.Subrs) {
        dict.Private = Object.assign({}, dict.Private);
        dict.Private.Subrs = this.subsetSubrs(
          dict.Private.Subrs,
          used_subrs[i],
        );
      }
    }

    return;
  }

  createCIDFontdict(topDict) {
    let used_subrs = this.localSubrUsage;

    let privateDict = Object.assign({}, this.cff.topDict.Private);
    if (this.cff.topDict.Private && this.cff.topDict.Private.Subrs) {
      privateDict.Subrs = this.subsetSubrs(
        this.cff.topDict.Private.Subrs,
        used_subrs,
      );
    }

    topDict.FDArray = [{ Private: privateDict }];
    return (topDict.FDSelect = {
      version: 3,
      nRanges: 1,
      ranges: [{ first: 0, fd: 0 }],
      sentinel: this.charstrings.length,
    });
  }

  addString(string) {
    if (!string) {
      return null;
    }

    if (!this.strings) {
      this.strings = [];
    }

    this.strings.push(string);
    return standardStrings.length + this.strings.length - 1;
  }

  encode() {
    this.subsetCharstrings();

    let charset = {
      version: this.charstrings.length > 255 ? 2 : 1,
      ranges: [{ first: 1, nLeft: this.charstrings.length - 2 }],
    };

    let topDict = Object.assign({}, this.cff.topDict);
    topDict.Private = null;
    topDict.charset = charset;
    topDict.Encoding = null;
    topDict.CharStrings = this.charstrings;

    for (let key of [
      'version',
      'Notice',
      'Copyright',
      'FullName',
      'FamilyName',
      'Weight',
      'PostScript',
      'BaseFontName',
      'FontName',
    ]) {
      topDict[key] = this.addString(this.cff.string(topDict[key]));
    }

    topDict.ROS = [this.addString('Adobe'), this.addString('Identity'), 0];
    topDict.CIDCount = this.charstrings.length;

    if (this.cff.isCIDFont) {
      this.subsetFontdict(topDict);
    } else {
      this.createCIDFontdict(topDict);
    }

    let top = {
      version: 1,
      hdrSize: this.cff.hdrSize,
      offSize: 4,
      header: this.cff.header,
      nameIndex: [this.cff.postscriptName],
      topDictIndex: [topDict],
      stringIndex: this.strings,
      globalSubrIndex: this.gsubrs,
    };

    return CFFTop.toBuffer(top);
  }
}
