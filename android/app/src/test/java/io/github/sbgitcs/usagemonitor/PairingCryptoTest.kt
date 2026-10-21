package io.github.sbgitcs.usagemonitor

import io.github.sbgitcs.usagemonitor.pairing.PairingCrypto
import io.github.sbgitcs.usagemonitor.pairing.PairingLink
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** Checks the phone against the vectors the desktop's tests use (test/fixtures/phone-vectors.json). */
class PairingCryptoTest {
    private val vectors = JSONObject(File(System.getProperty("phoneVectors") ?: "../../test/fixtures/phone-vectors.json").readText())

    @Test
    fun derivesTheSameIdsAndKeysAsTheDesktop() {
        val code = vectors.getString("code")
        val master = PairingCrypto.masterKey(code)
        assertEquals(vectors.getString("normalized"), PairingCrypto.normalizeCode(code))
        assertEquals(vectors.getString("device_id"), PairingCrypto.deviceId(code))
        assertEquals(vectors.getString("master_key"), PairingCrypto.encodeKey(master))
        assertEquals(vectors.getString("mac_key"), PairingCrypto.encodeKey(PairingCrypto.subKey(master, "um-mac-v1")))
        assertEquals(vectors.getString("enc_key"), PairingCrypto.encodeKey(PairingCrypto.subKey(master, "um-enc-v1")))
        assertEquals(vectors.getString("signature"), PairingCrypto.sign(master, vectors.getString("method"), vectors.getString("path"), vectors.getLong("time")))
    }

    @Test
    fun opensTheDesktopsRepliesOnlyForTheirOwnRequest() {
        val master = PairingCrypto.masterKey(vectors.getString("code"))
        val box = vectors.getJSONObject("box")
        val time = vectors.getLong("time")
        val plain = PairingCrypto.decrypt(master, time, box.getString("iv"), box.getString("data"))
        assertEquals(vectors.getString("plaintext"), plain)
        assertThrows(Exception::class.java) { PairingCrypto.decrypt(master, time + 1, box.getString("iv"), box.getString("data")) }
        val other = PairingCrypto.masterKey("ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ")
        assertThrows(Exception::class.java) { PairingCrypto.decrypt(other, time, box.getString("iv"), box.getString("data")) }
    }

    @Test
    fun readsTheDesktopsPairingLink() {
        val info = PairingLink.parse(vectors.getString("link"))
        assertNotNull(info)
        assertEquals(listOf("192.168.1.20", "100.101.102.103"), info!!.addresses)
        assertEquals(47329, info.port)
        assertEquals("Studio PC", info.name)
        assertEquals(vectors.getString("normalized"), info.code)
    }

    @Test
    fun rejectsLinksAndCodesThatCannotPair() {
        assertNull(PairingLink.parse("https://example.com/pair?h=1.2.3.4&c=ABCDE-FGHJK-MNPQR-STVWX"))
        assertNull(PairingLink.parse("usagemonitor://pair?h=1.2.3.4&c=SHORT"))
        assertNull(PairingLink.parse("usagemonitor://pair?h=evil.example&c=ABCDE-FGHJK-MNPQR-STVWX"))
        assertEquals(47329, PairingLink.manual("192.168.1.5", "abcde fghjk mnpqr stvwx")!!.port)
        assertEquals(50000, PairingLink.manual("192.168.1.5:50000", "ABCDEFGHJKMNPQRSTVWX")!!.port)
        assertNull(PairingLink.manual("192.168.1.500", "ABCDEFGHJKMNPQRSTVWX"))
        assertNull(PairingLink.manual("192.168.1.5:99999", "ABCDEFGHJKMNPQRSTVWX"))
    }

    @Test
    fun pairingLinksOnlyReachPrivateAndVpnAddresses() {
        for (ok in listOf("10.0.0.1", "172.16.0.1", "172.31.255.254", "192.168.0.10", "100.64.0.1", "100.127.255.254"))
            assertTrue(ok, PairingLink.isAddress(ok))
        for (bad in listOf("8.8.8.8", "172.15.0.1", "172.32.0.1", "192.169.0.1", "100.63.255.255", "100.128.0.1",
                "127.0.0.1", "0.0.0.0", "255.255.255.255", "169.254.1.1", "١٩٢.١٦٨.١.١", "192.168.1"))
            assertFalse(bad, PairingLink.isAddress(bad))
        val link = "usagemonitor://pair?h=8.8.8.8,192.168.1.20&c=ABCDE-FGHJK-MNPQR-STVWX"
        assertEquals(listOf("192.168.1.20"), PairingLink.parse(link)!!.addresses)
        assertNull(PairingLink.parse("usagemonitor://pair?h=8.8.8.8,127.0.0.1&c=ABCDE-FGHJK-MNPQR-STVWX"))
        assertNull(PairingLink.manual("203.0.113.5", "ABCDEFGHJKMNPQRSTVWX"))
    }

    @Test
    fun keysFromTheComputerRoundTrip() {
        // Node's randomBytes(32).toString("base64url") for these bytes: unpadded, with the URL alphabet.
        val bytes = intArrayOf(250, 31, 68, 105, 142, 179, 216, 253, 34, 71, 108, 145, 182, 219, 0, 37, 74, 111, 148, 185,
            222, 3, 40, 77, 114, 151, 188, 225, 6, 43, 80, 117).map { it.toByte() }.toByteArray()
        val fromNode = "-h9EaY6z2P0iR2yRttsAJUpvlLneAyhNcpe84QYrUHU"
        assertArrayEquals(bytes, PairingCrypto.decodeKey(fromNode))
        assertEquals(fromNode, PairingCrypto.encodeKey(bytes))
    }
}
