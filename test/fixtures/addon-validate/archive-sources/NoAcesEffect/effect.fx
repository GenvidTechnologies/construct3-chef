// Placeholder effect shader fixture content (not a real shader).
// Effect addons ship no aces.json — that's the case this fixture exercises.
void main()
{
	gl_FragColor = texture2D(samplerFront, vTex);
}
