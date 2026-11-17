jouzu-cli-images-description = Leave images that the provider rejected out of later requests
jouzu-cli-images-rejected = The provider rejected an image in this conversation, so every later request would fail the same way. Run { $command } to leave the images of the failed request out of later requests. The session keeps them.
jouzu-cli-images-omitted = { $count ->
    [one] One image is left out of later requests.
   *[other] { $count } images are left out of later requests.
}
jouzu-cli-images-restored = Omitted images are sent again with later requests.
jouzu-cli-images-nothingRejected = No request was rejected because of an image.
jouzu-cli-images-nothingOmitted = No images are omitted.
jouzu-cli-images-usage = Use { $omit } after a provider rejects an image, or { $restore } to send omitted images again.
