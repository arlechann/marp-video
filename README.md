# marp-video

Marp のスライドと Markdown の読み上げ台本から、VOICEVOX の音声付き MP4 動画を生成する CLI ツールです。スライドと台本は別ファイルで管理し、ページの出現順で対応させます。

詳しい形式と処理規則は [SPEC.md](SPEC.md) を参照してください。

## 必要なもの

- Node.js 24.21.0 と npm（Node.js のバージョンは `.nvmrc` に記載）
- FFmpeg と FFprobe
- Marp CLI の画像生成に対応するブラウザー（Google Chrome、Microsoft Edge、Mozilla Firefox のいずれか）
- VOICEVOX ENGINE。付属スクリプトで起動する場合は Docker または Podman

Marp CLI は npm の依存関係として導入します。VOICEVOX ENGINE とブラウザー、FFmpeg／FFprobe は別途用意してください。

## セットアップ

このリポジトリで以下を実行します。`fnm` を使用している場合は `.nvmrc` のバージョンを選択してください。

```bash
fnm use
npm ci
npm run build
npm link
```

`npm link` 後は、別の作業ディレクトリからも `marp-video` コマンドを使用できます。グローバルにリンクしたくない場合は、リポジトリ内で `npm start -- build slides.md script.md` と実行できます。この場合、入力ファイルの相対パスはリポジトリから解決されます。コードを変更した後は `npm run build` を再実行してください。

## VOICEVOX ENGINE の起動と speaker ID の確認

VOICEVOX ENGINE はビルド時に自動起動しません。付属スクリプトでは Docker を優先し、Docker がなければ Podman を使用します。ランタイムを引数で指定することもできます。

```bash
./scripts/start-voicevox.sh
# または
./scripts/start-voicevox.sh podman
```

このスクリプトは公式 CPU イメージ `docker.io/voicevox/voicevox_engine:cpu-latest` をフォアグラウンドで起動し、`127.0.0.1:50021` に公開します。終了は `Ctrl+C` です。

台本の `speaker` に指定するのはスタイル ID です。エンジンの起動後、次のコマンドで ID・話者名・スタイル名を確認できます。

```bash
./scripts/list-voicevox-speakers.sh
```

既定以外の接続先を使う場合は、一覧表示スクリプトには URL を引数で、ビルドには `--voicevox-url` で指定します。

## 入力ファイル

`slides.md` は Marp 形式のスライドです。

```markdown
---
marp: true
---

# 1ページ目

説明する内容

---

# 2ページ目

次の内容
```

`script.md` は UTF-8 の Markdown ファイルです。先頭に必須の YAML Front Matter を置き、本文の単独行 `---` でページを分けます。Front Matter の `---` はページ数に含めません。スライドと台本のページ数は一致させてください。

```markdown
---
voicevox:
  speaker: 3
  speedScale: 1.0
  pages:
    "2":
      speaker: 8
---

# 1ページ目の台本

最初のページを説明します。

---

# 2ページ目の台本

次のページを説明します。
```

`voicevox` 直下の値は全ページ共通で、`pages` の引用符付きページ番号でページごとに上書きできます。`speaker` は各ページで決定できる必要があります。`pauseLengthScale` は未指定なら本ツールが `1.5` を適用し、それ以外の未指定の読み上げ設定には VOICEVOX の初期値を使用します。利用できる設定キーは [SPEC.md の Front Matter 仕様](SPEC.md#52-front-matter) を参照してください。

台本は `markdown-it` の CommonMark として解釈され、見出しや強調などの記号を除いたテキストを読み上げます。見出しの文字自体は読み上げます。読み間違いを避ける表記は台本側で調整してください。生の HTML と、読み上げ結果が空になるページは使用できません。段落の空行を増やしても無音時間を指定することはできません。

## 動画を生成する

入力ファイルがあるディレクトリで実行します。

```bash
marp-video build slides.md script.md
```

入力の相対パスはコマンドを実行したディレクトリを基準に解決します。標準の出力先は `slides.md` と同じディレクトリの `build/video-YYYYMMDDTHHMMSSmmm.mp4` です。ファイル名にはローカル時刻を使用し、同名が既にあれば連番を付けます。既存の動画は上書きしません。

主なオプションは次のとおりです。

| オプション | 内容 |
| --- | --- |
| `--output PATH` | タイムスタンプを付ける前の MP4 ファイル名。相対パスは実行ディレクトリ基準。既定は `slides.md` の隣の `build/video.mp4` |
| `--voicevox-url URL` | VOICEVOX ENGINE の接続先。既定は `http://127.0.0.1:50021` |
| `--gap-ms N` | 通常ページの音声終了から次ページへの切り替えまでの余白。既定は `1000` ms |
| `--tail-ms N` | 最終ページの音声終了後の余白。既定は `3000` ms |
| `--allow-local-files` | スライド内のローカル画像などへのアクセスを Marp に許可 |
| `--keep-intermediates` | 一時スライド画像と WAV を保持し、保存先を表示 |
| `--verbose` | Marp、FFprobe、FFmpeg の出力を実行中に表示 |
| `--help` | ヘルプを表示 |

`--gap-ms` と `--tail-ms` には0以上の整数を指定します。`--output` には `.mp4` で終わるファイル名を指定します。

例えば余白を変更して出力先を指定する場合は次のようにします。

```bash
marp-video build slides.md script.md --gap-ms 1500 --tail-ms 4000 --output result.mp4
```

余白は生成した音声の後に追加されます。`script.md` の `postPhonemeLength` は VOICEVOX が生成する音声の末尾に含まれる無音時間で、`--gap-ms`／`--tail-ms` とは別です。動画は 1280×720 ピクセル、30 fps、H.264 映像と AAC 音声の MP4 です。

## 中間ファイルとトラブルシューティング

スライド PNG とページ別 WAV は、通常は OS の一時ディレクトリ（Linux では通常 `/tmp`）の `marp-video-...` に生成され、ビルド終了時に削除されます。内容を確認する場合は `--keep-intermediates` を付けて再生成してください。保存先は進捗ログに表示されます。

- `VOICEVOXの確認` で失敗する場合は、ENGINE が起動しているか、`--voicevox-url` と `speaker` のスタイル ID が正しいかを確認してください。
- `スライド画像の生成` で失敗する場合は、対応ブラウザーの有無とスライド中のローカル素材を確認してください。外部ツールの出力は `--verbose` で確認できます。Marp の実行が5分を超えた場合もエラーになります。
- スライド数と台本ページ数が違う場合、または台本の Front Matter・ページ境界・読み上げ設定が不正な場合はビルドを停止します。

## 開発用コマンド

```bash
npm run typecheck
npm test
npm run build
npm run lint
npm run format:check
```

`npm run format` で TypeScript、`package.json`、整形設定を整形できます。
