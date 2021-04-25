#!/usr/bin/env python3

import abc
import dateutil as du
import datetime as dt

class Reader(abc.ABC):
    @abc.abstractmethod
    def has_next(self):
        pass

    @abc.abstractmethod
    def peek1(self):
        pass

    @abc.abstractmethod
    def read1(self):
        pass

class DummyReader(Reader):
    def __init__(self, timestamps, data):
        self.index = 0
        self.timestamps = timestamps
        self.data = data

        if len(data) < 1 or len(data) != len(timestamps):
            raise ValueError()

    def _length(self):
        return len(self.timestamps)

    def has_next(self):
        return self.index < self._length()

    def peek1(self):
        return (self.timestamps[self.index], self.data[self.index])

    def read1(self):
        r = (self.timestamps[self.index], self.data[self.index])
        self.index += 1
        return r

# pitfalls:
# - edges
# - need more predictions than observations?
class RMSE:
    def __init__(self, obs_reader, pred_reader):
        self.obs_reader = obs_reader
        self.pred_reader = pred_reader
        # tuples (ts, data)
        self.pred1 = pred_reader.read1()
        self.pred2 = pred_reader.read1()
        self.obs = None
        pass

    def _has_next_pred(self):
        return self.obs_reader.has_next()

    def _next_pred(self): # load next prediction
        self.pred1 = self.pred2
        self.pred2 = self.pred_reader.read1()

    def _has_next_obs(self):
        return self.obs_reader.has_next()

    def _next_obs(self):  # load next observation
        self.obs = self.obs_reader.read1()
        pass

    def _can_interpolate(self):
        return self.pred1[0] <= self.obs[0] < self.pred2[0]

    def _get_interpolation(self):
        dist1 = self.obs[0] - self.pred1[0]
        dist2 = self.pred2[0] - self.obs[0]
        return (dist2 * self.pred1[1] + dist1 * self.pred2[1]) / (dist1+dist2)

    def calculate(self): # can only be called once
        sum_squares = 0
        count = 0
        # go through all the observations one by one
        while self._has_next_obs():
            self._next_obs()

            # find appropriate predictions from which we can interpolate
            # prediction at the observation's timestamp
            while not self._can_interpolate() and self._has_next_pred():
                self._next_pred()
            if self._can_interpolate():
                pred = self._get_interpolation()
                diff = pred - self.obs[1]
                print(diff)
                sum_squares += diff**2
                count += 1

        return sum_squares / count

if __name__ == "__main__":
    def test():
        obs = DummyReader([1, 2, 3, 4, 5], [1, 2, 3, 4, 5])
        pred = DummyReader([1, 2, 3, 4, 5], [2, 3, 4, 5, 6])

        rm = RMSE(obs, pred)
        print("RMSE:", rm.calculate())


    test()
