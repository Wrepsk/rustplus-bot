# Camera rendering references and fixtures

The ray codec, palette and sample shuffle in `src/cameras/ray-image.ts` are adapted from [liamcottle/rustplus.js camera.js](https://github.com/liamcottle/rustplus.js/blob/master/camera.js). Sample accumulation was cross-checked against [HandyS11/RustPlusApi's CameraRenderer](https://github.com/HandyS11/RustPlusApi/blob/develop/src/RustPlusApi.Camera/CameraRenderer.cs). Public camera fixture data under `tests/fixtures/camera/` comes from that project's camera unit tests; it contains sample offsets and ray bytes, not pairing credentials. These fixtures are third-party captures, not live integration tests performed on this bot.

rustplus.js declares the MIT license in its package metadata; RustPlusApi includes an MIT license file. Attribution and license text follow.

## rustplus.js

Author: Liam Cottle. License: MIT (upstream package metadata).

## RustPlusApi

Copyright (c) 2024 Clergue Valentin

## MIT license (applies separately to each notice above)

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
SOFTWARE.
