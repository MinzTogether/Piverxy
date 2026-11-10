package io.github.piverxy;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;

/**
 * Tells whether two files hold exactly the same bytes (MediaControlsPlugin.sameFile).
 *
 * Moving the downloads to another folder (mobile/shims/store.js) may delete the old copy of a song only when the
 * copy in the new folder is provably the same file. The same name and the same size prove nothing: two different
 * songs can have both. Both files are read in small pieces (a FLAC is 30-150 MB and is never held whole), and the
 * reading stops at the first difference. No code here writes, renames or deletes anything.
 */
final class FileCompare {
    private static final int PIECE = 64 * 1024;

    private FileCompare() {}

    /**
     * @return true only when both files have the same length and every byte is equal; false as soon as they differ
     * @throws IOException when either one is not a readable file: the caller must then treat the songs as "not
     *                     proven the same" and keep both
     */
    static boolean sameBytes(File a, File b) throws IOException {
        if (!a.isFile() || !b.isFile()) throw new IOException("not a file");
        if (a.length() != b.length()) return false;
        try (InputStream x = new FileInputStream(a); InputStream y = new FileInputStream(b)) {
            byte[] bx = new byte[PIECE];
            byte[] by = new byte[PIECE];
            while (true) {
                int n = fill(x, bx);
                int m = fill(y, by);
                if (n != m) return false; // one of them is shorter than it said
                if (n == 0) return true; // both ended together
                for (int i = 0; i < n; i++) {
                    if (bx[i] != by[i]) return false;
                }
            }
        }
    }

    // reads until the buffer is full or the stream ends; a stream may hand over less than asked for without being at its end
    private static int fill(InputStream in, byte[] buf) throws IOException {
        int at = 0;
        while (at < buf.length) {
            int r = in.read(buf, at, buf.length - at);
            if (r < 0) break;
            at += r;
        }
        return at;
    }
}
