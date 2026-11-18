# Orkestra

İşi birkaç ajana bölen, her değişikliği başka bir firmanın modeline inceleten ve değişikliğin birleşip birleşmeyeceğine bir modelin değil bir betiğin karar verdiği bir Claude Code eklentisi.

[English](README.md) · MIT · `0.6.1` · test takımı Linux, macOS ve Windows'ta geçiyor

Bir **şef** planlar ve karar verir. **Yazıcıların** her biri kendi dosyalarının sahibidir. **Diğer firmadan bir inceleyici** (Claude'un işini Codex, Codex'in işini Claude) hata arar. Küçük bir **doğrulayıcı** testleri çalıştırır. Bir ajanın "bitti"si, ancak çalıştırdığı komutlar ve çıkış kodlarıyla birlikte sayılır.

```text
/orkestra:orkestra okuyucuya çevrimdışı önbellek ekle ve testlerle kapsa
```

## Ne için

Orkestra büyük işler içindir: bir site, oyun, uygulama ya da araç yapmak, video düzenlemek; çok sayıda dosyaya, adıma ya da oturuma yayılan her iş. Bu tür işlerde verim sağlar: her parçayı onu bitirebilecek en ucuz modele verir, şefi her şeyi yeniden okumaktan alıkoyar ve hataları birleşmeden önce yakalar. Bu alanların her birinde gerçek işlerde kullanılarak geliştirilir; denendiği her alan ona yeni testler ve kurallar ekler.

| Alan | Durum |
|---|---|
| Oyunlar (2D, 3D, web ve Godot) | Kullanılıyor; ölçüldü (aşağıdaki tablo) |
| Siteler | Kullanılıyor; bir mağaza sitesinde ölçüldü |
| Uygulamalar ve araçlar | Kullanılıyor |
| Video düzenleme | Kullanılıyor; storyboard'dan bir fragmanda ölçüldü |

## Şimdiye kadarki kanıtlar

Aşağıdaki rakamlar yazarın kendi projelerinden (anonim; tam kayıt [docs/measurements.md](docs/measurements.md)).

| İş | Düzen | Ölçülen sonuç |
|---|---|---|
| Godot oyunu, büyük bir iş grubu | Aynı ölçekte iş, Orkestra'dan önce ve sonra | Claude önbellek okuması 355 M → 23,7 M (yaklaşık 15 kat az); Codex incelemeleri 13 turun 9'unda gerçek hata buldu |
| Web oyunu: stil rehberi, konsept kareler, arayüz, uygulama | Codex yazdı ve çizdi, 3 bağımsız inceleme | Birleşmeden önce 2 gerçek hata bulundu |
| Aynı oyun: 13 adet 3D model (GLB) | Ayrı dosyalarda 2 paralel Codex yazıcı | Birleştirme çakışması yok |
| Aynı oyun: efektler ve düşman yeniden tasarımı | 5 Codex yazımı, 1 inceleme, 1 duman testi | İnceleme 2, duman testi 2 hata daha buldu |
| Statik mağaza sitesi, ilgisiz bir proje | Birleştirme kapısını denemek için 2 küçük düzeltme | Sitenin `node --test` komutunun "12 geçti" derken hiç test çalıştırmadığı bulundu; Orkestra hiç yanlış red vermedi |
| Animasyon dizisi: onaylı storyboard'lardan 9:16 fragman | Planları, kırpmaları ve başlıkları Codex seçti; ffmpeg hattını bir Claude işçisi yazdı | 22,6 sn fragman; Codex incelemeleri hatta 9 gerçek hata buldu; tasarımcı denetimi Codex'in 3 görünüm hatasını yakaladı |
| 12 günlük olağan kullanım | 46 oturum | 673 Codex çağrısı, 144 işçi ve 91 doğrulayıcı koşusu |

## Kimin için

- **Claude Code** kullanıyorsunuz ve işleriniz birkaç dosyaya, birkaç adıma ya da birkaç oturuma yayılıyor.
- Claude'un yazdığını **başka bir firmanın modeli** (varsayılan olarak OpenAI Codex) incelesin istiyorsunuz, tersi de.
- Bir işin ajan ve model başına maliyetini görmek istiyorsunuz.

~150 satırın altındaki tek dosyalık bir değişiklikte ekip ek yük getirir; Orkestra bunu fark eder ve değişikliği doğrudan yapar.

## Bir iş nasıl akar

```mermaid
flowchart LR
    U([Siz: tek görev]) --> C[Şef<br/>kapsar, böler, karar verir]
    C --> B[(Pano<br/>parçalar · sahipler · kanıt)]
    C -->|brif| W1[Yazıcı A<br/>Codex]
    C -->|brif| W2[Yazıcı B<br/>Claude işçi]
    W1 --> V[Doğrulayıcı<br/>testleri çalıştırır]
    W2 --> V
    V --> R{Diğer firmadan<br/>inceleyici}
    R -->|REVISE| W1
    R -->|APPROVE| G[close_part.js<br/>kapı + birleştirme]
    G --> B
    G --> M([Birleşti, ölçüldü,<br/>denemeye hazır])
```

1. **Kapsam.** Şef neyin zaten var olduğuna bakar ve size yalnızca yönü değiştiren soruları sorar.
2. **Bölme.** İş bir panoda (`.orkestra/<iş>/board.md`, git'e girmez) parçalara ayrılır. Her parça kendi dosyalarının sahibidir; paralel yazıcılar asla aynı dosyaya dokunmaz.
3. **Yazma.** Her parça onu bitirebilecek en ucuz araca gider: geniş ya da görsel işler Codex'e, bitirmek için çalıştırılması gereken kod bir Claude işçiye, mekanik düzenlemeler Haiku'ya.
4. **Doğrulama.** Küçük bir model kabul komutunu çalıştırır. Yazıcı kendi işini onaylayamaz.
5. **İnceleme.** Diğer firma, birleşecek commit'lerin tam olarak kendisini bir diff dosyasından inceler ve sabit bir JSON karar döner.
6. **Birleştirme.** `close_part.js` yalnızca inceleme geçtiyse **ve** tam o commit'leri kapsıyorsa birleştirir; yüksek riskli bir parça iki bağımsız inceleme ister.
7. **Ölçme.** `/orkestra:measure` her ajanın maliyetini gösterir ve koşuyu kurallara göre denetler.

## Hızlı başlangıç

**1. Eklentiyi kurun**
```bash
claude plugin marketplace add forvanius/orkestra
claude plugin install orkestra@orkestra
```

**2. Codex'i kurup giriş yapın** (varsayılan ikinci firma)
```bash
npm i -g @openai/codex
codex login
```
Güncel tutun: eski bir Codex CLI yeni modelleri "model is not supported" diye reddeder. Codex yok mu? Claude Code'un kendisi (`claude -p`) ikinci yazıcı ve inceleyici olabilir — bkz. [docs/instruments.md](docs/instruments.md).

**3. Codex modelinizi seçin.** Eklenti etkinleşince Claude Code sorar (sonradan `/config` ile değiştirilir).

**4. Projenizde bir iş başlatın:**
```text
/orkestra:orkestra <yapılmasını istediğiniz şey>
```

**5. Bitince ölçün:**
```text
/orkestra:measure
```

Gerekenler: [Claude Code](https://code.claude.com), Node.js, git. Windows'ta geliştirildi ve pilot işlerle denendi; CI test takımını Windows, macOS ve Linux'ta çalıştırır.

## Sonunda elinizde ne olur

- Dalınızda birleşmiş commit'ler; her parça diğer firmaca incelenmiş ve bir test koşusuyla denetlenmiş.
- Her parçayı, yazıcısını, incelemesini ve kanıtını kaydeden bir pano; yeni bir oturum devam etmek için onu kullanır.
- Açıp çalıştırabileceğiniz bir şeyi değiştiren işlerde: nasıl açılacağı, neyin deneneceği ve neyin bitmediğine dair kısa bir not, masaüstü ve mobil görüntülerle.
- Bir maliyet tablosu: ajan ve model başına çağrı ve token okuması, bir önceki koşunuzla karşılaştırmalı.

Panoda bir parçanın kanıtı şöyle görünür:
```text
| A | codex | merged | src/reader.js, tests/reader.test.js | npm test -- reader | 3f9c2a1 | review=review-A.json |
```

## Değişiklikler nasıl denetlenir

- Her ajan, çalıştırdığı komutlar ve çıkış kodlarıyla birlikte bir karar döner; bunlar olmadan verilen onay ret sayılır.
- Her brif testleri silmeyi ya da gevşetmeyi, eşik değiştirmeyi ve hata yutmayı yasaklar; inceleyici diff'te bunlara bakar.
- `red_check.js` yeni bir testi düzeltmeyle (geçmeli) ve düzeltme olmadan (kalmalı) çalıştırır, sonra dosyaları olduğu gibi geri koyar.
- Bir inceleme belirli commit'leri kapsar; sonradan eklenen bir commit kendi incelemesini ister.
- Orkestra çalışma ağacınızda yıkıcı git komutu çalıştırmaz ve sizin kendi merge'ünüz ya da cherry-pick'iniz sürerken birleştirme yapmaz.

## Ayarlar

| Seçenek | Ne yapar |
|---|---|
| `codex_model` | Her `codex exec` çağrısının modeli (yazma, inceleme). |
| `codex_model_design` | İsteğe bağlı, tasarım için daha güçlü model: konseptler, görseller, 2D/3D varlık ayarı. |
| `codex_model_light` | İsteğe bağlı, mekanik parçalar için daha ucuz Codex modeli (yoksa Haiku işçi). |
| `gemini_model` | Yalnızca Google'ın CLI'ını yazıcı ya da inceleyici olarak eklerseniz. |

`/config` ile ya da `settings.json` içinde `pluginConfigs["orkestra@orkestra"].options` altından ayarlanır. Tekrarlanan proje kurallarını reponuzun `AGENTS.md` dosyasına yazın: Claude ajanları da Codex de okur, brifler kısa kalır.

## Sık sorulanlar

**Maliyeti ne?** İşe göre değişir. Ölçülen koşularda Claude önbellek okuması, aynı ölçekte tamamen Claude ile kurulan düzene göre yaklaşık 15 kat azaldı; Codex kullanımı OpenAI planınızdandır ve bu rakama dahil değildir. `/orkestra:measure` kendi koşularınızın rakamlarını gösterir.

**Codex limitine takılırsa?** `guarded.js` her çalıştırmadan önce Codex kotanıza bakar. Sınıra yaklaşınca durur ve şef size sorar: beklemek mi, parçayı Claude'a vermek mi.

**Bırakıp yarın devam edebilir miyim?** Evet. Pano devir notudur; yeni bir oturum onu okuyup açık parçalardan devam eder. Şefin bağlamı yeni bir oturumun daha ucuz olacağı kadar büyüyünce bir hook bunu söyler.

**Hangi diller?** Beceri İngilizce yazılmıştır; şef sizinle sizin dilinizde konuşur. Panolar İngilizce ya da Türkçe başlık kullanabilir.

## Daha fazlası

- [docs/example.md](docs/example.md) — baştan sona bir iş
- [docs/instruments.md](docs/instruments.md) — Codex, Claude Code (headless) ve Gemini/Antigravity tarifleri
- [docs/measurements.md](docs/measurements.md) — kuralların arkasındaki koşular
- [skills/orkestra/SKILL.md](skills/orkestra/SKILL.md) — şefin kuralları

## Durum

`0.6.1`. Ekim 2026'dan beri yazarın projelerinde kullanılıyor. Birleştirme kapısının bugünkü hâli (commit'e bağlı onay, yüksek riskli parçalar için iki inceleme, kırmızı kontrol) daha yeni; biri ilgisiz bir projede olmak üzere beş pilot işte çalıştı. Issue'larınız ve kendi rakamlarınız (çağrılar, rol başına okumalar, bulunan hatalar) memnuniyetle karşılanır.

## Olası sonraki adımlar

Henüz yapılmadı; yön belli olsun diye yazıldı.
- Karar defteri: her işin önemli kararlarının işler arasında saklanması, böylece sonraki bir iş onları yeniden açmaz.
- Tarayıcı ve görsel kontroller: bugün proje bunlara sahipse (örneğin Playwright) ve kabul komutu onları çağırıyorsa çalışırlar; kısa bir kurulum tarifi bunu kolaylaştırabilir.

## Kullanım notları

- Her incelemeyi `review_package.js` ile paketleyin ve sonucunu `review-<ad>.json` olarak adlandırın; `close_part.js` tam olarak bu incelemelerin kapsadığını birleştirir.
- `red_check.js`'i testi dışarıdan öldüren bir zaman sınırı olmadan çalıştırın.

## Lisans

[MIT](LICENSE)
