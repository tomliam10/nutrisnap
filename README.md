# NutriSnap

Photo → dish name, ingredient breakdown, estimated grams, calories, protein, carbs and fat.
Plus daily calorie burn (BMR/TDEE) from your weight, height, gender, age and activity.

Standalone Capacitor app (iOS + Android). The phone talks straight to the Claude API over the internet;
there is no server. Each user pastes their own Anthropic API key in **Profile → AI connection**
(stored only on the device).

## Android
```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"   # Capacitor 8 needs Java 21+
export ANDROID_HOME=$HOME/Library/Android/sdk
cd android && ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```
Or `npm run android` and press Run in Android Studio.

## iOS
`npm run ios`, pick your phone, set your Team under Signing & Capabilities, press Run.

## After editing `www/`
`npx cap sync`

## Notes
- Estimates only; not medical advice.
- Before a public store release, replace the bring-your-own-key model with a small backend that holds the key.
