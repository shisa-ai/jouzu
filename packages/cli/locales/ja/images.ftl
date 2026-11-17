jouzu-cli-images-description = プロバイダーが拒否した画像を以降のリクエストから除外します
jouzu-cli-images-rejected = この会話の画像がプロバイダーに拒否されたため、以降のリクエストもすべて同じように失敗します。{ $command } を実行すると、失敗したリクエストの画像を以降のリクエストから除外します。画像はセッションに残ります。
jouzu-cli-images-omitted = { $count ->
   *[other] { $count } 件の画像を以降のリクエストから除外します。
}
jouzu-cli-images-restored = 除外した画像を以降のリクエストで再び送信します。
jouzu-cli-images-nothingRejected = 画像が原因で拒否されたリクエストはありません。
jouzu-cli-images-nothingOmitted = 除外中の画像はありません。
jouzu-cli-images-usage = プロバイダーが画像を拒否したときは { $omit }、除外した画像を再び送信するには { $restore } を使います。
