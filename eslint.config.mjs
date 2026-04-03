import antfu from '@antfu/eslint-config'
import blueprintPlugin from '@blueprintjs/eslint-plugin'

export default antfu(
  {
    react: true,
    typescript: true,
    gitignore: false,
  },
  blueprintPlugin.flatConfigs.recommended,
)
