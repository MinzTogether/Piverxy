package io.github.piverxy;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.util.Random;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

/**
 * FileCompare decides whether the old copy of a song may be deleted after a move (PIV-STORE-001): only equal bytes
 * count, never the same name or the same size. Plain JVM test: ./gradlew testDebugUnitTest
 */
public class FileCompareTest {
    private File dir;

    @Before
    public void setUp() throws IOException {
        dir = Files.createTempDirectory("filecompare").toFile();
    }

    @After
    public void tearDown() {
        File[] all = dir.listFiles();
        if (all != null) for (File f : all) f.delete();
        dir.delete();
    }

    private File write(String name, byte[] bytes) throws IOException {
        File f = new File(dir, name);
        Files.write(f.toPath(), bytes);
        return f;
    }

    @Test
    public void sameBytesAreTheSame() throws IOException {
        assertTrue(FileCompare.sameBytes(write("a", "AAAA".getBytes()), write("b", "AAAA".getBytes())));
    }

    @Test
    public void sameNameSameSizeButOtherBytesAreNotTheSame() throws IOException {
        // the case that used to get the old copy deleted: equal length, different content
        assertFalse(FileCompare.sameBytes(write("a", "AAAA".getBytes()), write("b", "BBBB".getBytes())));
    }

    @Test
    public void otherSizeIsNotTheSame() throws IOException {
        assertFalse(FileCompare.sameBytes(write("a", "AAAA".getBytes()), write("b", "AAAAA".getBytes())));
    }

    @Test
    public void emptyFilesAreTheSame() throws IOException {
        assertTrue(FileCompare.sameBytes(write("a", new byte[0]), write("b", new byte[0])));
    }

    @Test
    public void aDifferenceAnywhereInALargeFileIsFound() throws IOException {
        byte[] big = new byte[5 * 1024 * 1024 + 123];
        new Random(1).nextBytes(big);
        File a = write("a", big);
        assertTrue(FileCompare.sameBytes(a, write("same", big.clone())));
        byte[] last = big.clone();
        last[last.length - 1] ^= 1;
        assertFalse(FileCompare.sameBytes(a, write("last", last)));
        byte[] boundary = big.clone();
        boundary[64 * 1024] ^= 1; // first byte of the second piece
        assertFalse(FileCompare.sameBytes(a, write("boundary", boundary)));
    }

    @Test
    public void aFileThatCannotBeReadIsNeverTheSame() throws IOException {
        File a = write("a", "AAAA".getBytes());
        try {
            FileCompare.sameBytes(a, new File(dir, "missing"));
            fail("a missing file must not be reported as the same");
        } catch (IOException expected) {
            // the caller keeps both files
        }
        try {
            FileCompare.sameBytes(dir, a);
            fail("a folder must not be reported as the same");
        } catch (IOException expected) {
            // same
        }
    }
}
