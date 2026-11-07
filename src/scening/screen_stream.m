#import <CoreMedia/CoreMedia.h>
#import <Foundation/Foundation.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#include <math.h>

typedef struct {
    uint32_t displayID;
    size_t width;
    size_t height;
} SceningDisplay;

typedef struct {
    CVPixelBufferRef pixel;
    const void *bytes;
    size_t width;
    size_t height;
    size_t stride;
    double capturedAt;
    int64_t error;
} SceningFrame;

enum { FrameFailed = -1, FrameEmpty, FrameComplete, FrameIdle, FrameUnavailable, FrameWaiting };

@interface SceningScreenSlot : NSObject <SCStreamOutput, SCStreamDelegate> {
    SCStream *_stream;
    dispatch_group_t _lifetime;
    CVPixelBufferRef _latest;
    double _capturedAt;
    BOOL _observed;
    BOOL _unavailable;
    BOOL _started;
    BOOL _closing;
    int64_t _error;
}
@property(nonatomic) SceningDisplay display;
- (void)start:(SCDisplay *)display fps:(double)fps queue:(dispatch_queue_t)queue lifetime:(dispatch_group_t)lifetime;
- (void)fail:(int64_t)code;
- (int)take:(SceningFrame *)frame;
- (void)stop;
@end

@implementation SceningScreenSlot

// 调用方持有槽锁。旧表面在替换或停止时立即归还给系统。
- (void)clearLatest {
    if (_latest) CVPixelBufferRelease(_latest);
    _latest = NULL;
    _capturedAt = 0;
    _observed = NO;
}

- (void)dealloc {
    [self clearLatest];
}

- (void)fail:(int64_t)code {
    @synchronized (self) {
        _error = code ?: -1;
        [self clearLatest];
    }
}

- (void)finishStream {
    _stream = nil;
    dispatch_group_leave(_lifetime);
}

- (void)stopStartedStream {
    SCStream *stream = _stream;
    [stream stopCaptureWithCompletionHandler:^(NSError *error) {
        @synchronized (self) {
            if (stream == self->_stream) [self finishStream];
        }
    }];
}

- (void)start:(SCDisplay *)display fps:(double)fps queue:(dispatch_queue_t)queue lifetime:(dispatch_group_t)lifetime {
    @synchronized (self) {
        if (_closing) return;
        SCContentFilter *filter = [[SCContentFilter alloc] initWithDisplay:display excludingWindows:@[]];
        SCStreamConfiguration *config = [SCStreamConfiguration new];
        config.width = self.display.width;
        config.height = self.display.height;
        config.pixelFormat = kCVPixelFormatType_32BGRA;
        config.minimumFrameInterval = CMTimeMakeWithSeconds(1 / fps, 1000000);
        config.queueDepth = 3;
        config.showsCursor = NO;
        if (@available(macOS 13.0, *)) config.capturesAudio = NO;
        SCStream *stream = [[SCStream alloc] initWithFilter:filter configuration:config delegate:self];
        NSError *error = nil;
        if (![stream addStreamOutput:self type:SCStreamOutputTypeScreen sampleHandlerQueue:queue error:&error]) {
            [self fail:error.code];
            return;
        }
        _stream = stream;
        _lifetime = lifetime;
        dispatch_group_enter(_lifetime);
        [stream startCaptureWithCompletionHandler:^(NSError *failure) {
            @synchronized (self) {
                if (stream != self->_stream) return;
                if (failure) {
                    [self fail:failure.code];
                    [self finishStream];
                    return;
                }
                self->_started = YES;
                if (self->_closing) [self stopStartedStream];
            }
        }];
    }
}

- (void)stop {
    @synchronized (self) {
        if (_closing) return;
        _closing = YES;
        [self clearLatest];
        if (_stream && _started) [self stopStartedStream];
    }
}

- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error {
    @synchronized (self) {
        if (stream != _stream) return;
        [self fail:error.code];
        [self finishStream];
    }
}

- (void)stream:(SCStream *)stream didOutputSampleBuffer:(CMSampleBufferRef)sample ofType:(SCStreamOutputType)type {
    if (type != SCStreamOutputTypeScreen || !CMSampleBufferIsValid(sample)) return;
    @autoreleasepool {
        NSArray *attachments = (__bridge NSArray *)CMSampleBufferGetSampleAttachmentsArray(sample, false);
        NSNumber *status = attachments.firstObject[SCStreamFrameInfoStatus];
        if (!status) return;
        SCFrameStatus state = status.integerValue;
        @synchronized (self) {
            if (_closing || stream != _stream) return;
            if (state == SCFrameStatusBlank || state == SCFrameStatusSuspended || state == SCFrameStatusStopped) {
                [self clearLatest];
                _unavailable = YES;
                return;
            }
            if (state == SCFrameStatusComplete) {
                CVPixelBufferRef pixel = CMSampleBufferGetImageBuffer(sample);
                if (!pixel) return;
                if (_latest) CVPixelBufferRelease(_latest);
                _latest = CVPixelBufferRetain(pixel);
                _observed = YES;
                _unavailable = NO;
            } else if (state != SCFrameStatusIdle || !_observed) {
                return;
            }
            // 帧时间来自媒体的主机时钟。空闲帧确认同一像素内容仍在显示。
            CMTime host = CMClockGetTime(CMClockGetHostTimeClock());
            CMTime pts = CMSampleBufferGetPresentationTimeStamp(sample);
            double age = CMTimeGetSeconds(CMTimeSubtract(host, pts));
            _capturedAt = NSDate.date.timeIntervalSince1970 - (isfinite(age) && age > 0 ? age : 0);
        }
    }
}

- (int)take:(SceningFrame *)frame {
    @synchronized (self) {
        if (_error) {
            frame->error = _error;
            return FrameFailed;
        }
        if (_closing || _unavailable) return FrameUnavailable;
        if (!_capturedAt) return _observed ? FrameEmpty : FrameWaiting;
        frame->capturedAt = _capturedAt;
        _capturedAt = 0;
        frame->pixel = _latest;
        _latest = NULL;
        return frame->pixel ? FrameComplete : FrameIdle;
    }
}
@end

@interface SceningScreenGroup : NSObject
@property(nonatomic, strong) NSDictionary<NSNumber *, SceningScreenSlot *> *slots;
@property(nonatomic, strong) dispatch_group_t lifetime;
@end
@implementation SceningScreenGroup
@end

// 独占采集线程创建会话。共享一次可采集屏幕查询，异步启动各屏，无需阻塞 Python。
void *scening_stream_open(const SceningDisplay *displays, size_t count, double fps) {
    @autoreleasepool {
        SceningScreenGroup *group = [SceningScreenGroup new];
        NSMutableDictionary *slots = [NSMutableDictionary dictionaryWithCapacity:count];
        for (size_t i = 0; i < count; i++) {
            SceningScreenSlot *slot = [SceningScreenSlot new];
            slot.display = displays[i];
            slots[@(displays[i].displayID)] = slot;
        }
        group.slots = slots;
        group.lifetime = dispatch_group_create();
        dispatch_queue_t output = dispatch_queue_create("scening.screen-frames", DISPATCH_QUEUE_SERIAL);
        [SCShareableContent getShareableContentExcludingDesktopWindows:NO onScreenWindowsOnly:YES
                                                    completionHandler:^(SCShareableContent *content, NSError *error) {
            NSMutableDictionary *available = [NSMutableDictionary dictionary];
            for (SCDisplay *display in content.displays) available[@(display.displayID)] = display;
            for (NSNumber *displayID in group.slots) {
                SceningScreenSlot *slot = group.slots[displayID];
                SCDisplay *display = available[displayID];
                if (display) [slot start:display fps:fps queue:output lifetime:group.lifetime];
                else [slot fail:error.code];
            }
        }];
        return (__bridge_retained void *)group;
    }
}

// 像素引用转交给读取方；Pillow 复制完成后调用 frame_release 归还系统缓冲。
int scening_stream_take(void *handle, uint32_t displayID, SceningFrame *frame) {
    @autoreleasepool {
        SceningScreenGroup *group = (__bridge SceningScreenGroup *)handle;
        int result = [group.slots[@(displayID)] take:frame];
        if (result != FrameComplete) return result;
        CVPixelBufferRef pixel = frame->pixel;
        CVReturn status = CVPixelBufferLockBaseAddress(pixel, kCVPixelBufferLock_ReadOnly);
        if (status != kCVReturnSuccess) {
            CVPixelBufferRelease(pixel);
            frame->pixel = NULL;
            frame->error = status;
            return FrameFailed;
        }
        frame->width = CVPixelBufferGetWidth(pixel);
        frame->height = CVPixelBufferGetHeight(pixel);
        frame->stride = CVPixelBufferGetBytesPerRow(pixel);
        frame->bytes = CVPixelBufferGetBaseAddress(pixel);
        return FrameComplete;
    }
}

void scening_stream_frame_release(CVPixelBufferRef pixel) {
    CVPixelBufferUnlockBaseAddress(pixel, kCVPixelBufferLock_ReadOnly);
    CVPixelBufferRelease(pixel);
}

void scening_stream_stop(void *handle) {
    @autoreleasepool {
        SceningScreenGroup *group = (__bridge SceningScreenGroup *)handle;
        for (SceningScreenSlot *slot in group.slots.allValues) [slot stop];
    }
}

bool scening_stream_wait(void *handle, double timeout) {
    SceningScreenGroup *group = (__bridge SceningScreenGroup *)handle;
    return dispatch_group_wait(group.lifetime, dispatch_time(DISPATCH_TIME_NOW, timeout * NSEC_PER_SEC)) == 0;
}

void scening_stream_release(void *handle) {
    @autoreleasepool {
        (void)CFBridgingRelease(handle);
    }
}
