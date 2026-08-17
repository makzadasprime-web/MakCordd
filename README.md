# Makcord

Chat e chamadas (áudio, vídeo e chamadas em grupo com até 6 pessoas) entre
amigos, direto do navegador — sem servidor próprio, pronto para rodar no
**GitHub Pages**.

## Como funciona

O GitHub Pages só serve arquivos estáticos (HTML/CSS/JS), então o Makcord
usa **[PeerJS](https://peerjs.com/)** para abrir conexões diretas
(WebRTC) entre os navegadores dos amigos. O único servidor externo
envolvido é o broker público e gratuito do PeerJS — ele só ajuda dois
navegadores a se "encontrarem"; depois disso, texto, áudio e vídeo trafegam
direto entre os dois computadores.

**"Adicionar por nome" funciona assim:** cada nome de usuário vira um ID
de conexão fixo (`makcord-<nome>`). Por isso não existe cadastro nem
banco de dados — quem souber o nome exato de alguém consegue se conectar
a essa pessoa, contanto que ela esteja com o Makcord aberto no navegador
no mesmo momento.

## Rodando localmente

Não precisa de build nem de `npm install`. É só abrir `index.html` num
servidor estático qualquer (pode ser o `Live Server` do VS Code, ou):

```bash
npx serve .
# ou
python3 -m http.server 8080
```

> Abrir o arquivo direto com `file://` **não funciona** — o navegador
> bloqueia câmera/microfone e o WebRTC fora de `http(s)`.

## Publicando no GitHub Pages

1. Crie um repositório e suba estes três arquivos (`index.html`,
   `style.css`, `app.js`) na raiz (ou numa pasta `docs/`).
2. No repositório: **Settings → Pages → Source**, escolha a branch
   (`main`) e a pasta (`/root` ou `/docs`).
3. Aguarde alguns minutos — o GitHub publica em
   `https://<seu-usuario>.github.io/<repositorio>/`.
4. Pronto: é `https://`, então câmera, microfone e WebRTC funcionam
   normalmente.

## Usando o app

1. Cada pessoa abre o link do GitHub Pages e escolhe um **nome único**.
2. Para conversar com alguém, digite o nome exato dela em
   **"Adicionar amigo por nome"**.
3. Clique no nome na lista para abrir o chat. Os ícones ☎ e ▣ no topo
   iniciam uma chamada de voz ou vídeo com essa pessoa.
4. Para chamar o grupo: alguém clica em **"Criar sala"** (isso a torna a
   anfitriã) e avisa o próprio nome de usuário para os amigos. Cada amigo
   digita esse nome em **"Entrar com nome do anfitrião"** para entrar —
   até 6 pessoas por sala.

## Limitações importantes (por ser 100% estático)

- **Os dois precisam estar online ao mesmo tempo.** Não há servidor para
  guardar mensagens ou tocar o telefone de alguém offline — se o amigo
  não estiver com a aba aberta, a mensagem fica salva só no seu navegador
  e a chamada não completa.
- **Nomes são por ordem de chegada.** Como o nome vira o próprio endereço
  de conexão, quem escolher um nome primeiro "fica" com ele enquanto
  estiver conectado; se duas pessoas tentarem usar o mesmo nome ao mesmo
  tempo, a segunda recebe um aviso para escolher outro.
- **Histórico é local.** As conversas ficam salvas só no `localStorage`
  do navegador de cada pessoa — trocar de navegador/dispositivo ou limpar
  os dados do site apaga o histórico.
- **Broker público do PeerJS.** É gratuito e ótimo para uso entre amigos,
  mas tem limites de uso justo; para um grupo grande ou uso pesado, vale
  rodar seu próprio [PeerServer](https://github.com/peers/peerjs-server)
  (aí basta trocar a criação do `new Peer(...)` em `app.js`).
- **Chamada em grupo é malha (mesh).** Cada participante liga direto para
  os outros, então o consumo de upload cresce com o número de pessoas —
  6 é um limite confortável para a maioria das conexões residenciais.

## Estrutura

```
index.html   → estrutura da interface
style.css    → design (tema escuro, minimalista)
app.js       → toda a lógica: Peer.js, chat, chamadas 1:1 e sala em grupo
```
