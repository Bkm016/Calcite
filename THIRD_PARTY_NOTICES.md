# Third-party notices

Calcite does not bundle the software below; it downloads it at runtime from the original publishers and
verifies the published checksums.

## HeadlessMC

Calcite launches Minecraft through [HeadlessMC](https://github.com/headlesshq/headlessmc) (pinned release,
SHA-256 verified), which is distributed under the following license:

```
MIT License

Copyright (c) 2025 3arthqu4ke

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.```

## Minecraft

Minecraft game files, libraries, assets and mappings are downloaded from Mojang's servers and are subject to the
[Minecraft EULA](https://www.minecraft.net/eula) and the
[Minecraft Usage Guidelines](https://www.minecraft.net/usage-guidelines). Mojang's obfuscation maps are used only
at runtime to locate game classes and are never redistributed.

## Java runtimes

When no suitable Java installation is found, Calcite downloads Eclipse Temurin builds from
[Adoptium](https://adoptium.net) (GPLv2 with Classpath Exception).
