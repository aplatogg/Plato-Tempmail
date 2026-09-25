# Third-party notices

This file records third-party licenses; it does not grant or invent a license for Plato-Tempmail's
original source. Versions below reflect the installed dependency tree and lockfile reviewed for
this implementation. Preserve these notices with distributions containing the corresponding code.
Development tools retain their own licenses in their packages; this runtime inventory does not
relicense those tools or Cloudflare's service.

## Runtime dependency inventory

| Package | Version | License | Copyright notice |
| --- | --- | --- | --- |
| hono | 4.13.8 | MIT | Copyright (c) 2021 - present, Yusuke Wada and Hono contributors |
| html-to-text | 10.0.1 | MIT | Portions Copyright (c) 2012-2019 werk85 <malte@werk85.de>; Portions Copyright (c) 2020-2026 KillyMXI <killy@mxii.eu.org> |
| postal-mime | 3.0.0 | MIT-0 | Copyright (c) 2021-2025 Andris Reinman |
| @selderee/plugin-htmlparser2 | 0.12.0 | MIT | Copyright (c) 2021-2026 KillyMXI <killy@mxii.eu.org> |
| selderee | 0.12.0 | MIT | Copyright (c) 2021-2026 KillyMXI <killy@mxii.eu.org> |
| parseley | 0.13.1 | MIT | Copyright (c) 2021-2025 KillyMXI <killy@mxii.eu.org> |
| leac | 0.7.0 | MIT | Copyright (c) 2021-2025 KillyMXI <killy@mxii.eu.org> |
| peberminta | 0.10.0 | MIT | Copyright (c) 2021-2025 KillyMXI <killy@mxii.eu.org> |
| dom-serializer | 2.0.0 | MIT | Copyright (c) 2014 The cheeriojs contributors |
| htmlparser2 | 10.1.0 | MIT | Copyright 2010, 2011, Chris Winberry <chris@winberry.net>. All rights reserved. |
| deepmerge-ts | 8.0.2 | BSD-3-Clause | Copyright (c) 2021, Rebecca Stevens. All rights reserved. |
| domelementtype | 2.3.0 | BSD-2-Clause | Copyright (c) Felix Böhm. All rights reserved. |
| domhandler | 5.0.3 | BSD-2-Clause | Copyright (c) Felix Böhm. All rights reserved. |
| domutils | 3.2.2 | BSD-2-Clause | Copyright (c) Felix Böhm. All rights reserved. |
| entities | 4.5.0, 7.0.1 | BSD-2-Clause | Copyright (c) Felix Böhm. All rights reserved. |

Upstream direct dependencies: [Hono](https://github.com/honojs/hono),
[html-to-text](https://github.com/html-to-text/node-html-to-text),
[PostalMime](https://github.com/postalsys/postal-mime).
The exact package `LICENSE` / `LICENSE.txt` files remain authoritative. Recheck the inventory
against `npm ls --omit=dev --all` and the lockfile when upgrading dependencies.

## MIT license

The copyright notices in the MIT rows above accompany the following permission and disclaimer:

```text
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
```

## PostalMime — MIT-0

```text
Copyright (c) 2021-2025 Andris Reinman

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## deepmerge-ts — BSD-3-Clause

```text
Copyright (c) 2021, Rebecca Stevens
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## domelementtype, domhandler, domutils, entities — BSD-2-Clause

```text
Copyright (c) Felix Böhm
All rights reserved.

Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:

Redistributions of source code must retain the above copyright notice, this list
of conditions and the following disclaimer.

Redistributions in binary form must reproduce the above copyright notice, this
list of conditions and the following disclaimer in the documentation and/or
other materials provided with the distribution.

THIS IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS
OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT
SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT,
INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED
TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR
BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN
ANY WAY OUT OF THE USE OF THIS,
EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## Design reference only — Tempik

[Tempik](https://github.com/hirotomasato/tempik) (MIT) was a reference for the ingestion flow
and simple inbox UX. No Tempik source was copied as part of this implementation. Its
session-claim authorization model is not used here. This reference is not a claim of
affiliation, endorsement, or a license grant for Plato-Tempmail's original code.
