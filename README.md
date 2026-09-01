# RTSP Monitor

Sistema web local para descobrir e visualizar câmeras RTSP **sem autenticação** em ranges/CIDRs que você administra.

> Use apenas em redes e IPs sob sua autorização.

## 1. Requisitos

- **Node.js** 20+
- **npm**
- **FFmpeg** no `PATH` (somente necessário para visualizar streams no navegador)
- Rede local / VPN com permissão de administração nos ranges configurados

## 2. Instalação

```bash
cd rtsp-monitor
npm install
```

## 3. Configuração dos ranges

Edite `config.json`:

```json
{
  "port": 3000,
  "ranges": [
    "192.168.1.0/24",
    "192.168.10.0/24",
    "10.20.0.0/16"
  ],
  "rtspPort": 554,
  "scan": {
    "concurrency": 500,
    "timeout": 1000,
    "rtspConcurrency": 20
  },
  "rtspPaths": [
    "/",
    "/stream1",
    "/live",
    "/Streaming/Channels/101"
  ],
  "stream": {
    "idleTimeoutMs": 60000,
    "segmentTime": 2
  }
}
```

| Campo | Descrição |
|--------|-----------|
| `ranges` | Lista de CIDRs/IPs autorizados (IPv4) |
| `rtspPort` | Porta TCP a testar (padrão 554) |
| `scan.concurrency` | Conexões TCP simultâneas |
| `scan.timeout` | Timeout de connect TCP (ms) |
| `scan.rtspConcurrency` | Probes RTSP simultâneos |
| `rtspPaths` | Paths RTSP testados sem credenciais |
| `stream.idleTimeoutMs` | Encerra FFmpeg após ociosidade |
| `stream.segmentTime` | Duração dos segmentos HLS (s) |

O scanner **não** varre IPs fora desses ranges.

## 4. Como iniciar o servidor

Desenvolvimento (reload):

```bash
npm run dev
```

Produção simples:

```bash
npm start
```

Abra: [http://localhost:3000](http://localhost:3000)

Typecheck:

```bash
npm run typecheck
```

## 5. Como executar um scan

### Interface

1. Abra a UI
2. Clique em **Scan network**
3. Acompanhe o progresso em tempo real (SSE): IPs totais, verificados, porta 554 aberta, RTSP open, auth required, erros

### API

```bash
curl -X POST http://localhost:3000/api/scan
curl http://localhost:3000/api/scan/status
```

Eventos SSE:

```bash
curl -N http://localhost:3000/api/scan/events
```

### Artefatos gerados

- `data/open-rtsp-ports.txt` — IPs com TCP/554 aberto
- `data/cameras.json` — resultado do probe RTSP

Fluxo interno:

1. Expande CIDRs
2. Testa TCP `IP:554` (sem ping prévio), com pool de concorrência
3. Para cada IP aberto: `OPTIONS` → `DESCRIBE` → `SETUP` (TCP interleaved)
4. `401`/`403` → `auth_required` (sem tentativa de senha)
5. SETUP/DESCRIBE sem auth → `open`

## 6. Como visualizar as câmeras

1. Após o scan, a grade mostra IP, porta, status, metadados e tracks
2. Em câmeras `open`, clique em **Visualizar**
3. O backend sobe **FFmpeg** sob demanda e publica HLS em `/streams/<ip>/index.m3u8`
4. O player usa **hls.js** no navegador
5. Ao fechar o player (ou após idle), o processo FFmpeg é encerrado

API:

```bash
curl http://localhost:3000/api/cameras
curl http://localhost:3000/api/cameras/192.168.1.15/stream
curl -X DELETE http://localhost:3000/api/cameras/192.168.1.15/stream
```

## 7. Instalar / configurar o FFmpeg

### macOS (Homebrew)

```bash
brew install ffmpeg
ffmpeg -version
```

### Ubuntu / Debian

```bash
sudo apt update
sudo apt install ffmpeg
ffmpeg -version
```

### Windows

1. Baixe um build em https://ffmpeg.org/download.html
2. Extraia e adicione a pasta `bin` ao `PATH`
3. Confirme com `ffmpeg -version` no terminal

O monitor invoca `ffmpeg` diretamente. Não é necessário configurar paths extras se o binário estiver no `PATH`.

Transporte RTSP usado na conversão: **TCP** (`-rtsp_transport tcp`).

## 8. Limitações conhecidas

- Apenas **IPv4** no MVP
- Sem autenticação na interface web (pense em uso em rede admin/local)
- Sem brute force / bypass de senha — hosts com `401`/`403` são só marcados
- Cobertura de paths limitada à lista em `config.json`
- Alguns firmwares RTSP não padrão podem falhar no cliente mínimo
- HLS introduz **latência de alguns segundos** (não é tempo real estrito)
- FFmpeg com `-c:v copy` exige que o codec seja compatível com o container MPEG-TS/HLS (H.264 costuma funcionar; outros codecs podem precisar reencode)
- Ranges grandes (`/8`, `/16`) geram muitos IPs — ajuste `concurrency`/`timeout` e espere o scan TCP
- Não há banco de dados; estado em arquivos JSON/TXT
- Player e scan não são multi-usuário com controle de acesso

## API resumida

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/cameras` | Lista câmeras |
| POST | `/api/scan` | Inicia scan |
| GET | `/api/scan/status` | Snapshot do progresso |
| GET | `/api/scan/events` | SSE de progresso |
| GET | `/api/cameras/:ip/stream` | Inicia HLS |
| DELETE | `/api/cameras/:ip/stream` | Para HLS |
| GET | `/streams/:ip/*` | Segmentos HLS |

## Estrutura

```text
src/scanner/   CIDR, TCP scan, RTSP client, orchestrator
src/server/    HTTP API, SSE, FFmpeg/HLS
public/        UI estática
data/          resultados e streams temporários
config.json    ranges e tunables
```

## Licença / uso

Uso interno em redes autorizadas. Não utilize para escanear redes de terceiros sem permissão.
