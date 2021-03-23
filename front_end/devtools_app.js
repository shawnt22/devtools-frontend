// Copyright 2018 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.
import './shell.js';
import './panels/css_overview/css_overview-meta.js';
import './panels/elements/elements-meta.js';
import './panels/browser_debugger/browser_debugger-meta.js';
import './network/network-meta.js';
import './security/security-meta.js';
import './emulation/emulation-meta.js';
import './panels/accessibility/accessibility-meta.js';
import './panels/animation/animation-meta.js';
import './panels/developer_resources/developer_resources-meta.js';
import './inspector_main/inspector_main-meta.js';
import './resources/resources-meta.js';
import './issues/issues-meta.js';
import './panels/help/help-meta.js';
import './layers/layers-meta.js';
import './lighthouse/lighthouse-meta.js';
import './media/media-meta.js';
import './mobile_throttling/mobile_throttling-meta.js';
import './performance_monitor/performance_monitor-meta.js';
import './timeline/timeline-meta.js';
import './web_audio/web_audio-meta.js';
import './webauthn/webauthn-meta.js';
import './panels/layer_viewer/layer_viewer-meta.js';
import * as Startup from './startup/startup.js';  // eslint-disable-line rulesdir/es_modules_import

Startup.RuntimeInstantiator.startApplication('devtools_app');
