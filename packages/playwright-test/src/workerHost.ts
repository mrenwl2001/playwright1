/**
 * Copyright Microsoft Corporation. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { TestGroup } from './dispatcher';
import type { RunPayload, SerializedLoaderData, WorkerInitParams } from './ipc';
import { ProcessHost } from './processHost';

let lastWorkerIndex = 0;

export class WorkerHost extends ProcessHost<WorkerInitParams> {
  readonly parallelIndex: number;
  readonly workerIndex: number;
  private _hash: string;
  currentTestId: string | null = null;
  private _params: WorkerInitParams;

  constructor(testGroup: TestGroup, parallelIndex: number, loader: SerializedLoaderData) {
    const workerIndex = lastWorkerIndex++;
    super(require.resolve('./workerRunner.js'), `worker-${workerIndex}`);
    this.workerIndex = workerIndex;
    this.parallelIndex = parallelIndex;
    this._hash = testGroup.workerHash;

    this._params = {
      workerIndex: this.workerIndex,
      parallelIndex,
      repeatEachIndex: testGroup.repeatEachIndex,
      projectId: testGroup.projectId,
      loader,
    };
  }

  async start() {
    await this.startRunner(this._params);
  }

  runTestGroup(runPayload: RunPayload) {
    this.sendMessageNoReply({ method: 'runTestGroup', params: runPayload });
  }

  hash() {
    return this._hash;
  }
}
