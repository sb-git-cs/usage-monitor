package io.github.sbgitcs.usagemonitor

import io.github.sbgitcs.usagemonitor.pairing.PairingCrypto
import io.github.sbgitcs.usagemonitor.pairing.PairingLink
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
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
}
